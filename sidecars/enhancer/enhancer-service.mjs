import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SERVICE = '/exa.language_server_pb.LanguageServerService/';

export const DEFAULT_MODELS = [
  { id: '__follow_current__', label: '🔄 跟随当前对话模型', shortLabel: '跟随当前' },
  { id: 'MODEL_PLACEHOLDER_M320', label: '⚡ Gemini 3.8 Flash (Low · 极速推荐)', shortLabel: 'Flash 3.8 低' },
  { id: 'MODEL_PLACEHOLDER_M319', label: '⚡ Gemini 3.8 Flash (Medium)', shortLabel: 'Flash 3.8 中' },
  { id: 'MODEL_PLACEHOLDER_M318', label: '⚡ Gemini 3.8 Flash (High)', shortLabel: 'Flash 3.8 高' },
  { id: 'MODEL_PLACEHOLDER_M419', label: '🧠 Gemini 4 Argon (Low)', shortLabel: 'Argon 4 低' },
  { id: 'MODEL_PLACEHOLDER_M418', label: '🧠 Gemini 4 Argon (Medium)', shortLabel: 'Argon 4 中' },
  { id: 'MODEL_PLACEHOLDER_M417', label: '🧠 Gemini 4 Argon (High)', shortLabel: 'Argon 4 高' },
  { id: 'MODEL_PLACEHOLDER_M403', label: '🎭 Claude Sonnet 5.5 (Low)', shortLabel: 'Sonnet 5.5 低' },
  { id: 'MODEL_PLACEHOLDER_M404', label: '🎭 Claude Sonnet 5.5 (Medium)', shortLabel: 'Sonnet 5.5 中' },
  { id: 'MODEL_PLACEHOLDER_M405', label: '🎭 Claude Sonnet 5.5 (High)', shortLabel: 'Sonnet 5.5 高' },
  { id: 'MODEL_PLACEHOLDER_M400', label: '🏛️ Claude Opus 5.5 (Low)', shortLabel: 'Opus 5.5 低' },
  { id: 'MODEL_PLACEHOLDER_M401', label: '🏛️ Claude Opus 5.5 (Medium)', shortLabel: 'Opus 5.5 中' },
  { id: 'MODEL_PLACEHOLDER_M402', label: '🏛️ Claude Opus 5.5 (High)', shortLabel: 'Opus 5.5 高' },
  { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', label: '🌐 GPT-OSS 120B (Medium)', shortLabel: 'GPT-120B' },
];

export const ENHANCE_MODES = [
  {
    id: 'general',
    label: '🎯 通用全面增强',
    desc: '补全目标背景、关键细节、执行步骤与交付标准',
    instruction: '将用户的原始输入改写并扩充为结构清晰、意图明确、约束完备、可直接发送给 AI 执行的高质量提示词。适度补充目标定位、关键细节要求与期望输出格式，篇幅精炼得当，拒绝空洞套话。',
  },
  {
    id: 'coding',
    label: '💻 代码与架构研发',
    desc: '强化技术栈规范、边界条件、异常处理与验证要求',
    instruction: '将用户的原始输入改写为面向资深软件工程师/AI编程助手的专业研发提示词。明确技术栈与架构约束、输入输出边界、异常处理、性能与可维护性要求，以及代码交付与验证标准。完整保留原输入中的所有文件路径、符号名与报错信息。',
  },
  {
    id: 'research',
    label: '📊 深度调研与分析',
    desc: '强化多维拆解、数据论据、对比维度与结构化排版',
    instruction: '将用户的原始输入改写为深度研究与分析提示词。要求从背景脉络、核心机制、多维对比、真实案例/数据支撑及结论建议等维度展开，确保逻辑严密、信息密度高、层次分明。',
  },
  {
    id: 'concise',
    label: '✍️ 精炼去歧义润色',
    desc: '不扩写长篇，仅理顺逻辑、消除歧义、提升精准度',
    instruction: '在不显著增加篇幅的前提下，对用户的原始输入进行精准润色：消除口语歧义、理顺因果与先后逻辑、提炼核心指令，使其简洁有力、一针见血。保持单段或紧凑列表格式。',
  },
  {
    id: 'custom',
    label: '🛠️ 自定义优化指令',
    desc: '使用您自定义的提示词优化规则',
    instruction: '',
  },
];

export function getAppPaths() {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const profile = join(appData, 'Antigravity');
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(home, '.gemini', 'antigravity', 'sidecar_data', 'prompt-enhancer', 'enhancer', 'data');
  return {
    home,
    profile,
    logFile: join(profile, 'logs', 'language_server.log'),
    prefsFile: join(localAppData, 'AntigravityPromptEnhancer', 'preferences.json'),
    pluginConfig: join(home, '.gemini', 'config', 'config.json'),
    dataDir,
  };
}

export function makeShortLabel(label = '') {
  const clean = label.replace(/^[^\w\u4e00-\u9fa5]+/, '').trim();
  const tierMatch = clean.match(/\((Low|Medium|High).*?\)|\b(Low|Medium|High|低|中|高)\b/i);
  const tierMap = { low: '低', medium: '中', high: '高', '低': '低', '中': '中', '高': '高' };
  const tier = tierMatch ? (tierMap[(tierMatch[1] || tierMatch[2]).toLowerCase()] || '') : '';
  if (/flash/i.test(clean)) return `Flash 3.8${tier ? ' ' + tier : ''}`;
  if (/argon/i.test(clean)) return `Argon 4${tier ? ' ' + tier : ''}`;
  if (/sonnet/i.test(clean)) return `Sonnet 5.5${tier ? ' ' + tier : ''}`;
  if (/opus/i.test(clean)) return `Opus 5.5${tier ? ' ' + tier : ''}`;
  if (/gpt/i.test(clean)) return 'GPT-120B';
  return clean.slice(0, 12);
}

export class EnhancerService {
  constructor() {
    this.paths = getAppPaths();
    this.server = null;
    this.discoveredAt = 0;
    this.cachedModels = null;
    this.modelsAt = 0;
  }

  async discoverServer(force = false) {
    if (!force && this.server && Date.now() - this.discoveredAt < 15000) return this.server;
    if (!force && process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
      const port = Number(process.env.ANTIGRAVITY_LS_ADDRESS.split(':').pop());
      if (port > 0) {
        this.server = { port, csrf: process.env.ANTIGRAVITY_CSRF_TOKEN };
        this.discoveredAt = Date.now();
        return this.server;
      }
    }
    const psScript = "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match '--standalone' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true, timeout: 8000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(r => r?.ProcessId && r?.CommandLine);
    if (!rows.length) throw new Error('未检测到运行中的 Antigravity 语言服务');
    const row = rows[0];
    const csrf = row.CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
    if (!csrf) throw new Error('未能读取本地语言服务鉴权凭据');
    const { stdout: netOut } = await exec('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 4000 });
    const pidPorts = new Set();
    for (const line of netOut.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[2]) === Number(row.ProcessId)) pidPorts.add(Number(m[1]));
    }
    const logText = await readFile(this.paths.logFile, 'utf8');
    const port = [...logText.matchAll(/listening on random port at (\d+) for HTTP/g)].reverse().map(m => Number(m[1])).find(p => pidPorts.has(p));
    if (!port) throw new Error('未找到 Antigravity 本地 HTTP 端口');
    this.server = { port, csrf };
    this.discoveredAt = Date.now();
    return this.server;
  }

  async rpcCall(method, body = {}, timeoutMs = 45000, retry = true) {
    const srv = await this.discoverServer();
    try {
      return await new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request({
          hostname: '127.0.0.1',
          port: srv.port,
          method: 'POST',
          path: SERVICE + method,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': srv.csrf,
            'Content-Length': Buffer.byteLength(payload),
          },
        }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              return reject(Object.assign(new Error(`RPC ${method} HTTP ${res.statusCode}: ${text.slice(0, 200)}`), { status: res.statusCode }));
            }
            try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('解析响应 JSON 失败')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('大模型优化请求超时')));
        req.end(payload);
      });
    } catch (err) {
      if (retry && ([401, 403].includes(err.status) || ['ECONNREFUSED', 'ECONNRESET'].includes(err.code))) {
        this.server = null;
        await this.discoverServer(true);
        return this.rpcCall(method, body, timeoutMs, false);
      }
      throw err;
    }
  }
}

EnhancerService.prototype.getAvailableModels = async function(force = false) {
  if (!force && this.cachedModels && Date.now() - this.modelsAt < 60000) return this.cachedModels;
  try {
    const res = await this.rpcCall('GetUserStatus', {}, 8000);
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    if (configs.length > 0) {
      const dynamic = [{ id: '__follow_current__', label: '🔄 跟随当前对话模型', shortLabel: '跟随当前' }];
      for (const cfg of configs) {
        const id = cfg?.modelOrAlias?.model || cfg?.modelOrAlias?.alias;
        const rawLabel = cfg?.label || id;
        if (!id) continue;
        let icon = '✨';
        if (/flash/i.test(rawLabel)) icon = '⚡';
        else if (/argon/i.test(rawLabel)) icon = '🧠';
        else if (/sonnet/i.test(rawLabel)) icon = '🎭';
        else if (/opus/i.test(rawLabel)) icon = '🏛️';
        else if (/gpt/i.test(rawLabel)) icon = '🌐';
        const rec = id === 'MODEL_PLACEHOLDER_M320' ? ' · 极速推荐' : '';
        dynamic.push({
          id,
          rawLabel,
          label: `${icon} ${rawLabel.replace(/\((Low|Medium|High)\)/i, m => m.slice(0, -1) + rec + ')')}`,
          shortLabel: makeShortLabel(rawLabel),
        });
      }
      this.cachedModels = dynamic;
      this.modelsAt = Date.now();
      return dynamic;
    }
  } catch {}
  return DEFAULT_MODELS;
};

EnhancerService.prototype.resolveModelEnum = async function(selectedModel, hostModelText = '') {
  const models = await this.getAvailableModels();
  if (selectedModel && selectedModel !== '__follow_current__') {
    const found = models.find(m => m.id === selectedModel);
    if (found) return found;
  }
  if (hostModelText) {
    const norm = hostModelText.toLowerCase().replace(/select model,?\s*current:\s*/i, '')
      .replace(/高/g, 'high').replace(/中/g, 'medium').replace(/低/g, 'low');
    for (const m of models) {
      if (m.id === '__follow_current__') continue;
      const target = (m.rawLabel || m.label).toLowerCase().replace(/[^\w\s.]/g, '');
      const tokens = target.split(/\s+/).filter(Boolean);
      if (tokens.length && tokens.every(t => norm.includes(t))) return m;
    }
  }
  return models.find(m => m.id === 'MODEL_PLACEHOLDER_M320') || models[1] || DEFAULT_MODELS[1];
};

EnhancerService.prototype.loadPreferences = async function() {
  try {
    if (existsSync(this.paths.prefsFile)) {
      const raw = JSON.parse(await readFile(this.paths.prefsFile, 'utf8'));
      return {
        selectedModel: raw.selectedModel || 'MODEL_PLACEHOLDER_M320',
        selectedMode: raw.selectedMode || 'general',
        customSystemPrompt: typeof raw.customSystemPrompt === 'string' ? raw.customSystemPrompt : '',
        history: Array.isArray(raw.history) ? raw.history.slice(0, 15) : [],
      };
    }
  } catch {}
  return {
    selectedModel: 'MODEL_PLACEHOLDER_M320',
    selectedMode: 'general',
    customSystemPrompt: '',
    history: [],
  };
};

EnhancerService.prototype.savePreferences = async function(patch = {}) {
  const current = await this.loadPreferences();
  const next = {
    selectedModel: patch.selectedModel ?? current.selectedModel,
    selectedMode: patch.selectedMode ?? current.selectedMode,
    customSystemPrompt: patch.customSystemPrompt ?? current.customSystemPrompt,
    history: Array.isArray(patch.history) ? patch.history.slice(0, 15) : current.history,
  };
  await mkdir(dirname(this.paths.prefsFile), { recursive: true });
  await writeFile(this.paths.prefsFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
};

export function cleanEnhancedOutput(raw = '') {
  let s = String(raw || '').trim();
  // Remove leading conversational filler if any
  s = s.replace(/^(?:好的[，,。！!]?\s*)?(?:这是|以下是)?(?:为您)?(?:优化|改写|增强|润色)后的提示词[:：\s]*\n+/i, '');
  // If wrapped in a single outer markdown fence, unwrap it
  const fenceMatch = s.match(/^```(?:markdown|md|text|prompt)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  return s;
}

EnhancerService.prototype.enhancePrompt = async function({ text, model, hostModelText, mode, customSystemPrompt } = {}) {
  const rawInput = String(text || '').trim();
  if (!rawInput) throw new Error('输入框为空，请先输入需要优化的提示词');
  const prefs = await this.loadPreferences();
  const useModelId = model || prefs.selectedModel || 'MODEL_PLACEHOLDER_M320';
  const useModeId = mode || prefs.selectedMode || 'general';
  const customRule = customSystemPrompt ?? prefs.customSystemPrompt ?? '';

  const resolvedModel = await this.resolveModelEnum(useModelId, hostModelText);
  const modeObj = ENHANCE_MODES.find(m => m.id === useModeId) || ENHANCE_MODES[0];
  const ruleText = useModeId === 'custom' && customRule.trim()
    ? customRule.trim()
    : modeObj.instruction;

  const fullPrompt = [
    '你是一位顶级的提示词工程专家（Prompt Optimizer）。',
    '你的唯一任务是：将用户的【原始提示词】改写并增强为一段意图清晰、结构严谨、细节完备、可直接发送给大模型执行的高质量提示词。',
    '',
    '【优化策略与模式要求】',
    ruleText,
    '',
    '【严格输出铁律（必须 100% 遵守）】',
    '1. 严禁直接回答、执行或解答用户原始提示词中的问题！你的输出必须是“供用户发送给 AI 的改写后提示词本身”。',
    '2. 严禁包含任何寒暄、前言、解释、总结或后记（例如严禁出现“好的，优化后的提示词如下：”等废话），严禁使用最外层 ``` 代码块包裹整段输出，直接从提示词正文的第一个字开始输出。',
    '3. 必须 100% 保留用户原文中的关键上下文：包括但不限于文件路径、代码标识符、变量名、@提及项、/斜杠命令、数字指标及语言种类（原文为中文则输出地道简体中文）。',
    '',
    '【原始提示词】',
    rawInput,
    '',
    '【增强后的提示词正文】',
  ].join('\n');

  const startMs = Date.now();
  const response = await this.rpcCall('GetModelResponse', {
    prompt: fullPrompt,
    model: resolvedModel.id,
  }, 60000);
  const elapsedMs = Date.now() - startMs;
  const enhancedText = cleanEnhancedOutput(response?.response || '');
  if (!enhancedText) throw new Error('模型返回内容为空，请重试或切换其他优化模型');

  const record = {
    at: new Date().toISOString(),
    original: rawInput,
    enhanced: enhancedText,
    modelId: resolvedModel.id,
    modelLabel: resolvedModel.shortLabel || resolvedModel.label,
    modeId: useModeId,
    elapsedMs,
  };
  const history = [record, ...(prefs.history || [])].slice(0, 15);
  await this.savePreferences({
    selectedModel: useModelId,
    selectedMode: useModeId,
    customSystemPrompt: customRule,
    history,
  });

  return {
    enhancedText,
    modelUsed: resolvedModel.id,
    modelLabel: resolvedModel.shortLabel || resolvedModel.label,
    modeId: useModeId,
    elapsedMs,
  };
};
