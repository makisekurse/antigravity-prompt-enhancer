import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { EnhancerService, ENHANCE_MODES, getAppPaths } from './enhancer-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING_BASE = '__agPromptEnhancerCallV2';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_HTTP_BODY = 64 * 1024;

const service = new EnhancerService();
const paths = getAppPaths();
const ownerToken = randomUUID();
const startedAt = Date.now();
const ownerFile = join(paths.dataDir, 'active-sidecar.json');

function claimOwnership() {
  mkdirSync(paths.dataDir, { recursive: true });
  const tmp = `${ownerFile}.${process.pid}.${ownerToken.slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt, token: ownerToken }, null, 2) + '\n', 'utf8');
    renameSync(tmp, ownerFile);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function readOwnerState() {
  try {
    if (!existsSync(ownerFile)) return { state: 'owned' };
    const data = JSON.parse(readFileSync(ownerFile, 'utf8'));
    if (data.shutdown === true) return { state: 'shutdown' };
    if (data.token === ownerToken) return { state: 'owned' };
    return { state: 'superseded' };
  } catch {
    return { state: 'owned' };
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
  const call = (type, input = {}, timeoutMs = 68000) => new Promise(resolve => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: '本地增强服务响应超时' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    try {
      window[binding](JSON.stringify({ id, type, input }));
    } catch {
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
    init: () => call('init', {}, 12000),
    refresh: () => call('refresh', {}, 12000),
    enhance: payload => call('enhance', payload, 70000),
    cancel: requestKey => call('cancel', { requestKey }, 5000),
    savePrefs: payload => call('savePrefs', payload, 10000),
    clearHistory: () => call('clearHistory', {}, 10000),
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
      res.on('data', c => {
        body += c;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('Response too large'));
      });
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
    this.scriptId = null;
  }
  async open() {
    this.ws = new globalThis.WebSocket(this.url);
    this.ws.addEventListener('message', ev => {
      try {
        if (typeof ev.data !== 'string' || ev.data.length > 2 * 1024 * 1024) return;
        const msg = JSON.parse(ev.data);
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
    this.stopping = false;
  }

  async handleEvent(session, msg) {
    if (this.stopping || readOwnerState().state !== 'owned') return;
    const p = msg.params || {};
    if (msg.method === 'Runtime.bindingCalled' && p.name === this.binding) {
      if (typeof p.payload !== 'string' || p.payload.length > 512 * 1024) return;
      let req;
      try { req = JSON.parse(p.payload); } catch { return; }
      if (!Number.isSafeInteger(req?.id) || req.id < 1) return;
      let result = {};
      try {
        if (req.type === 'init' || req.type === 'refresh') {
          result = {
            models: await service.getAvailableModels(req.type === 'refresh'),
            modes: ENHANCE_MODES,
            prefs: await service.loadPreferences(),
          };
        } else if (req.type === 'enhance') {
          const payload = req.input || {};
          result = await service.enhancePrompt({
            ...payload,
            requestKey: payload.requestKey || `${session.url}:${req.id}`,
          });
        } else if (req.type === 'cancel') {
          result = { cancelled: service.cancelEnhance(req.input?.requestKey) };
        } else if (req.type === 'savePrefs') {
          result = await service.savePreferences(req.input || {});
        } else if (req.type === 'clearHistory') {
          result = await service.clearHistory();
        }
      } catch (e) {
        result = e.aborted ? { aborted: true } : { error: e.message || '执行异常' };
      }
      if (this.stopping || readOwnerState().state !== 'owned') return;
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
    try {
      await session.open();
      await session.command('Page.enable');
      await session.command('Runtime.enable');
      await session.command('Runtime.addBinding', { name: this.binding });
      const guarded = `if (location.origin === ${JSON.stringify(origin)}) {\n${this.source}\n}`;
      session.guarded = guarded;
      const added = await session.command('Page.addScriptToEvaluateOnNewDocument', { source: guarded });
      session.scriptId = added?.identifier || null;
      await session.command('Runtime.evaluate', { expression: guarded });
      return session;
    } catch (err) {
      await this.cleanupSession(session, false);
      throw err;
    }
  }

  async cleanupSession(session, disposePage = true) {
    try {
      if (session.scriptId) {
        await session.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId });
        session.scriptId = null;
      }
    } catch {}
    try { await session.command('Runtime.removeBinding', { name: this.binding }); } catch {}
    if (disposePage) {
      try {
        await session.command('Runtime.evaluate', {
          expression: `if (window.__agPromptEnhancerOwner === ${JSON.stringify(ownerToken)}) { window.__agPromptEnhancerDispose?.(); window.__agPromptEnhancerBridge?.dispose?.(); delete window.agPromptEnhancerHost; }`,
        });
      } catch {}
    }
    session.close();
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const ownerState = readOwnerState().state;
      if (ownerState === 'shutdown') {
        await this.detachAll(true);
        process.exit(0);
      }
      if (ownerState === 'superseded') {
        // Newer sidecar owns the page: only remove our own preloads/bindings, never dispose the newer widget!
        await this.detachAll(false);
        process.exit(0);
      }
      if (!isPluginEnabled()) {
        await this.detachAll(true);
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

  async detachAll(disposePage = true) {
    const list = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(list.map(s => this.cleanupSession(s, disposePage)));
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 2500);
  }

  async stop(disposePage = false) {
    this.stopping = true;
    clearInterval(this.timer);
    await this.detachAll(disposePage);
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
    const verFile = join(sdkDir, 'version.txt');
    const info = await stat(exe);
    const stamp = `${info.size}:${info.mtimeMs}`;
    let cached = false;
    try { cached = (await readFile(verFile, 'utf8')).trim() === stamp && existsSync(sdkFile); } catch {}
    if (!cached) {
      const bin = await readFile(exe);
      const marker = bin.indexOf('export class SidecarApp');
      const start = bin.lastIndexOf("import { execFileSync } from 'node:child_process';", marker);
      const tail = "return provided === this.#token;\n  }\n}\n";
      const tailIdx = bin.indexOf(tail, marker);
      if (marker > 0 && start >= 0 && tailIdx > marker) {
        await mkdir(sdkDir, { recursive: true });
        await writeFile(sdkFile, bin.subarray(start, tailIdx + Buffer.byteLength(tail)).toString('utf8'));
        await writeFile(verFile, stamp, 'utf8');
      }
    }
    if (existsSync(sdkFile)) return await import(pathToFileURL(sdkFile).href);
  }
  return null;
}

async function readJsonBody(req, limit = MAX_HTTP_BODY) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > limit) {
      throw Object.assign(new Error('请求体过大'), { status: 413 });
    }
  }
  return body.trim() ? JSON.parse(body) : {};
}

claimOwnership();
const injector = new RuntimeInjector();
injector.start();

let httpServer = null;
const gracefulExit = async () => {
  const forceTimer = setTimeout(() => process.exit(0), 2000);
  forceTimer.unref?.();
  try { httpServer?.close?.(); } catch {}
  const ownerState = readOwnerState().state;
  await injector.stop(ownerState === 'owned' || ownerState === 'shutdown');
  process.exit(0);
};
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { void gracefulExit(); });
}

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
    app.api('/api/prefs', async data => service.savePreferences(data || {}), 'POST');
    app.api('/api/history/clear', async () => service.clearHistory(), 'POST');
    app.api('/api/enhance', async data => {
      try { return await service.enhancePrompt(data || {}); }
      catch (e) { return new Response(JSON.stringify({ error: e.message || '执行异常' }), { status: 400, contentType: 'application/json' }); }
    }, 'POST');
    app.run();
  }
} else {
  const port = Number(process.env.AG_PE_PORT || 17895);
  httpServer = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      res.writeHead(403); res.end(); return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ models: await service.getAvailableModels(), modes: ENHANCE_MODES, prefs: await service.loadPreferences() }));
      return;
    }
    if (url.pathname === '/api/prefs' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(await service.savePreferences(await readJsonBody(req)))); }
      catch (e) { res.statusCode = e.status || 400; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (url.pathname === '/api/history/clear' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(await service.clearHistory())); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (url.pathname === '/api/enhance' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try { res.end(JSON.stringify(await service.enhancePrompt(await readJsonBody(req)))); }
      catch (e) { res.statusCode = e.status || 400; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(join(HERE, 'index.html'), 'utf8'));
      return;
    }
    res.writeHead(404); res.end();
  });
  httpServer.on('error', () => {});
  httpServer.listen(port, '127.0.0.1');
}
