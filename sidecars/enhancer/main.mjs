import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { EnhancerService, ENHANCE_MODES, getAppPaths } from './enhancer-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING_BASE = '__agPromptEnhancerCallV1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const service = new EnhancerService();
const paths = getAppPaths();
const ownerToken = randomUUID();
const startedAt = Date.now();
const ownerFile = join(paths.dataDir, 'active-sidecar.json');

function claimOwnership() {
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, startedAt, token: ownerToken }, null, 2), 'utf8');
}

function isCurrentOwner() {
  try {
    if (!existsSync(ownerFile)) return true;
    const data = JSON.parse(readFileSync(ownerFile, 'utf8'));
    return data.token === ownerToken;
  } catch {
    return true;
  }
}

function isPluginEnabled() {
  try {
    if (existsSync(paths.pluginConfig)) {
      const cfg = JSON.parse(readFileSync(paths.pluginConfig, 'utf8').replace(/^\uFEFF/, ''));
      if (cfg?.plugins?.['prompt-enhancer']?.enabled === false) return false;
    }
  } catch {}
  return true;
}

function rendererBridge(binding) {
  if (window !== window.top) return;
  window.__agPromptEnhancerBridge?.dispose?.();
  const pending = new Map();
  let seq = 0;
  const call = (type, input = {}) => new Promise(resolve => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: '本地增强服务响应超时' });
    }, 65000);
    pending.set(id, { resolve, timer });
    try {
      window[binding](JSON.stringify({ id, type, input }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ error: '本地增强桥接未就绪' });
    }
  });
  window.__agPromptEnhancerBridge = {
    resolve(id, result) {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      item.resolve(result);
    },
    dispose() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve({ error: '连接已重置' });
      }
      pending.clear();
      delete window.__agPromptEnhancerBridge;
    },
  };
  window.agPromptEnhancerHost = {
    init: () => call('init', {}),
    enhance: payload => call('enhance', payload),
    savePrefs: payload => call('savePrefs', payload),
  };
}

function buildInjectedSource(binding) {
  const rawWidget = readFileSync(join(HERE, 'inline-widget.cjs'), 'utf8');
  const prefix = 'module.exports = ';
  const idx = rawWidget.indexOf(prefix);
  const fnExpr = rawWidget.slice(idx + prefix.length).trim().replace(/;$/, '');
  const version = createHash('sha256').update(rawWidget + binding + ownerToken).digest('hex').slice(0, 16);
  return [
    `if (window.__agPromptEnhancerVer !== ${JSON.stringify(version)}) {`,
    `  window.__agPromptEnhancerDispose?.();`,
    `  window.__agPromptEnhancerBridge?.dispose?.();`,
    `  delete window.agPromptEnhancerHost;`,
    `  window.__agPromptEnhancerVer = ${JSON.stringify(version)};`,
    `  window.__agPromptEnhancerOwner = ${JSON.stringify(ownerToken)};`,
    `}`,
    `(${rendererBridge.toString()})(${JSON.stringify(binding)});`,
    `(${fnExpr})();`,
  ].join('\n');
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          resolve(JSON.parse(body));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

async function discoverCdpTargets() {
  const portFile = join(paths.profile, 'DevToolsActivePort');
  const text = await readFile(portFile, 'utf8');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DevToolsActivePort');
  const list = await httpGetJson(port, '/json/list');
  return (Array.isArray(list) ? list : []).filter(t => {
    try {
      const u = new URL(t.url);
      const ws = new URL(t.webSocketDebuggerUrl);
      return t.type === 'page' && ['http:', 'https:'].includes(u.protocol) && LOOPBACK.has(u.hostname) && LOOPBACK.has(ws.hostname);
    } catch { return false; }
  });
}

class CdpSession {
  constructor(url, onEvent, onClose) {
    this.url = url;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }
  async open() {
    this.ws = new globalThis.WebSocket(this.url);
    this.ws.addEventListener('message', ev => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id) {
          const item = this.pending.get(msg.id);
          if (!item) return;
          this.pending.delete(msg.id);
          clearTimeout(item.timer);
          if (msg.error) item.reject(new Error(msg.error.message || 'CDP error'));
          else item.resolve(msg.result || {});
        } else if (msg.method) {
          this.onEvent(msg);
        }
      } catch {}
    });
    this.ws.addEventListener('close', () => this.close());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('WS timeout')); }, 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('WS error')); }, { once: true });
    });
    return this;
  }
  command(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('Closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Command timeout')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Closed'));
    }
    this.pending.clear();
    try { this.ws?.close(); } catch {}
    this.onClose?.();
  }
}

class RuntimeInjector {
  constructor() {
    this.binding = `${BINDING_BASE}_${ownerToken.replace(/-/g, '').slice(0, 12)}`;
    this.source = buildInjectedSource(this.binding);
    this.sessions = new Map();
    this.busy = false;
  }

  async handleEvent(session, msg) {
    if (!isCurrentOwner()) return;
    const p = msg.params || {};
    if (msg.method === 'Runtime.bindingCalled' && p.name === this.binding) {
      let req;
      try { req = JSON.parse(p.payload); } catch { return; }
      if (!req?.id) return;
      let result = {};
      try {
        if (req.type === 'init') {
          result = {
            models: await service.getAvailableModels(),
            modes: ENHANCE_MODES,
            prefs: await service.loadPreferences(),
          };
        } else if (req.type === 'enhance') {
          result = await service.enhancePrompt(req.input || {});
        } else if (req.type === 'savePrefs') {
          result = await service.savePreferences(req.input || {});
        }
      } catch (e) {
        result = { error: e.message || '执行异常' };
      }
      const expr = `window.__agPromptEnhancerBridge?.resolve(${Number(req.id)}, ${JSON.stringify(result)})`;
      try {
        await session.command('Runtime.evaluate', {
          expression: expr,
          ...(p.executionContextId ? { contextId: p.executionContextId } : {}),
        });
      } catch {}
    }
  }

  async attachTarget(target) {
    const wsUrl = target.webSocketDebuggerUrl;
    const origin = new URL(target.url).origin;
    const session = new CdpSession(wsUrl, m => void this.handleEvent(session, m), () => this.sessions.delete(wsUrl));
    session.origin = origin;
    await session.open();
    await session.command('Page.enable');
    await session.command('Runtime.enable');
    await session.command('Runtime.addBinding', { name: this.binding });
    const guarded = `if (location.origin === ${JSON.stringify(origin)}) {\n${this.source}\n}`;
    session.guarded = guarded;
    await session.command('Page.addScriptToEvaluateOnNewDocument', { source: guarded });
    await session.command('Runtime.evaluate', { expression: guarded });
    return session;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!isCurrentOwner()) {
        for (const s of this.sessions.values()) s.close();
        this.sessions.clear();
        process.exit(0);
      }
      if (!isPluginEnabled()) {
        await this.detachAll();
        return;
      }
      const targets = await discoverCdpTargets();
      const activeUrls = new Set(targets.map(t => t.webSocketDebuggerUrl));
      for (const [url, s] of this.sessions) {
        if (!activeUrls.has(url) || s.closed) { s.close(); this.sessions.delete(url); }
      }
      for (const t of targets) {
        const wsUrl = t.webSocketDebuggerUrl;
        if (!this.sessions.has(wsUrl)) {
          try { this.sessions.set(wsUrl, await this.attachTarget(t)); } catch {}
        } else {
          const s = this.sessions.get(wsUrl);
          try {
            await s.command('Runtime.evaluate', {
              expression: `if (!window.__agPromptEnhancerInstalled || !window.agPromptEnhancerHost || window.__agPromptEnhancerOwner !== ${JSON.stringify(ownerToken)}) { ${s.guarded} }`,
            });
          } catch {}
        }
      }
    } catch {} finally {
      this.busy = false;
    }
  }

  async detachAll() {
    for (const s of this.sessions.values()) {
      try { await s.command('Runtime.evaluate', { expression: 'window.__agPromptEnhancerDispose?.();window.__agPromptEnhancerBridge?.dispose?.();' }); } catch {}
      s.close();
    }
    this.sessions.clear();
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 2500);
  }
}

async function loadSidecarSdk() {
  try { return await import('sidecar_sdk'); } catch {}
  try {
    const file = createRequire(import.meta.url).resolve('sidecar_sdk');
    return await import(pathToFileURL(file).href);
  } catch {}
  const exe = join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
  if (existsSync(exe)) {
    const sdkDir = join(paths.dataDir, 'sdk');
    const sdkFile = join(sdkDir, 'index.mjs');
    if (!existsSync(sdkFile)) {
      const bin = await readFile(exe);
      const marker = bin.indexOf('export class SidecarApp');
      const start = bin.lastIndexOf("import { execFileSync } from 'node:child_process';", marker);
      const tail = "return provided === this.#token;\n  }\n}\n";
      const tailIdx = bin.indexOf(tail, marker);
      if (marker > 0 && start >= 0 && tailIdx > marker) {
        await mkdir(sdkDir, { recursive: true });
        await writeFile(sdkFile, bin.subarray(start, tailIdx + Buffer.byteLength(tail)).toString('utf8'));
      }
    }
    if (existsSync(sdkFile)) return await import(pathToFileURL(sdkFile).href);
  }
  return null;
}

claimOwnership();
const injector = new RuntimeInjector();
injector.start();

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const sdk = await loadSidecarSdk();
  if (sdk?.SidecarApp) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();
    app.api('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), { contentType: 'text/html' }), 'GET');
    app.api('/api/state', async () => ({
      models: await service.getAvailableModels(),
      modes: ENHANCE_MODES,
      prefs: await service.loadPreferences(),
    }), 'GET');
    app.api('/api/enhance', async data => service.enhancePrompt(data || {}), 'POST');
    app.run();
  }
} else {
  const port = Number(process.env.AG_PE_PORT || 17895);
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.end(JSON.stringify({ models: await service.getAvailableModels(), modes: ENHANCE_MODES, prefs: await service.loadPreferences() }));
      return;
    }
    if (url.pathname === '/api/enhance' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      try { res.end(JSON.stringify(await service.enhancePrompt(JSON.parse(body || '{}')))); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(readFileSync(join(HERE, 'index.html'), 'utf8'));
  });
  srv.on('error', () => {});
  srv.listen(port, '127.0.0.1');
}
