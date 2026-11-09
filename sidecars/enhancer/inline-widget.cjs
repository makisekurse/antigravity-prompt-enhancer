// Self-contained Shadow DOM widget mounted right after the Model Selector in Antigravity composer.
module.exports = function installPromptEnhancerWidget() {
  if (window.__agPromptEnhancerInstalled) return;
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', installPromptEnhancerWidget, { once: true });
    return;
  }
  if (!window.agPromptEnhancerHost) return;
  window.__agPromptEnhancerInstalled = true;

  const HOST_ID = 'ag-prompt-enhancer-host';
  let hostNode = null;
  let shadow = null;
  let currentComposer = null;
  let menuOpen = false;
  let busy = false;
  let activeReqId = 0;
  let undoText = null;
  let redoText = null;
  let toastTimer = null;

  let state = {
    models: [
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
    ],
    modes: [
      { id: 'general', label: '🎯 通用增强', desc: '补全目标背景、关键细节、执行步骤与交付标准' },
      { id: 'coding', label: '💻 代码研发', desc: '强化技术栈规范、边界条件、异常处理与验证要求' },
      { id: 'research', label: '📊 深度调研', desc: '强化多维拆解、数据论据、对比维度与结构化排版' },
      { id: 'concise', label: '✍️ 精炼润色', desc: '不扩写长篇，仅理顺逻辑、消除歧义、提升精准度' },
      { id: 'custom', label: '🛠️ 自定义', desc: '使用您自定义的提示词优化系统指令' },
    ],
    selectedModel: localStorage.getItem('ag-pe-model') || 'MODEL_PLACEHOLDER_M320',
    selectedMode: localStorage.getItem('ag-pe-mode') || 'general',
    customSystemPrompt: localStorage.getItem('ag-pe-custom') || '',
  };

  function detectTheme() {
    const check = el => {
      if (!el) return null;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
      return lum >= 145 ? 'light' : 'dark';
    };
    return check(currentComposer?.box) || check(document.body) || check(document.documentElement) || 'light';
  }

  function readEditorText(editor) {
    if (!editor) return '';
    try {
      const lex = editor.__lexicalEditor;
      if (lex) {
        let out = '';
        lex.getEditorState().read(() => {
          const root = lex._editorState._nodeMap.get('root');
          if (root) out = root.getTextContent();
        });
        if (typeof out === 'string') return out;
      }
    } catch {}
    return editor.innerText || editor.textContent || '';
  }

  function writeEditorText(editor, newText) {
    if (!editor) return false;
    try {
      const lex = editor.__lexicalEditor;
      if (lex) {
        let ok = false;
        lex.update(() => {
          const root = lex._pendingEditorState._nodeMap.get('root');
          const Para = lex._nodes.get('paragraph')?.klass;
          const Text = lex._nodes.get('text')?.klass;
          if (root && Para && Text) {
            root.clear();
            const lines = String(newText).split(/\r?\n/);
            let lastP = null;
            for (const line of lines) {
              const p = new Para();
              if (line.length > 0) p.append(new Text(line));
              root.append(p);
              lastP = p;
            }
            if (lastP && typeof lastP.selectEnd === 'function') lastP.selectEnd();
            ok = true;
          }
        }, { discrete: true });
        if (ok) {
          editor.focus();
          return true;
        }
      }
    } catch {}
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, newText);
    return true;
  }

  function findTargetComposer() {
    const visible = el => el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]')).filter(visible);
    for (const box of boxes) {
      const editor = box.querySelector('[data-lexical-editor="true"], [role="combobox"][contenteditable="true"], [aria-label="Message input"]');
      const modelBtn = box.querySelector('[data-testid="model-selector-trigger"]');
      if (!visible(editor) || !visible(modelBtn)) continue;
      const footer = box.querySelector('.agy-composer-footer') || modelBtn.closest('.flex.w-full.items-center.justify-between');
      if (!footer) continue;
      let branch = modelBtn;
      while (branch.parentElement && branch.parentElement !== footer) {
        branch = branch.parentElement;
      }
      let modelWrap = modelBtn.closest('.no-focus-agent-input')?.parentElement || modelBtn.parentElement;
      return { box, editor, modelBtn, footer, branch, modelWrap };
    }
    return null;
  }

  const SPARKLE_SVG = `<svg class="icon-sparkle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7.5 2C7.8 5.1 9.1 6.4 12.2 6.7C9.1 7 7.8 8.3 7.5 11.4C7.2 8.3 5.9 7 2.8 6.7C5.9 6.4 7.2 5.1 7.5 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.3 10.2V13.4M10.7 11.8H13.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const SPINNER_SVG = `<svg class="icon-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/><path d="M13.5 8a5.5 5.5 0 0 0-5.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const CARET_SVG = `<svg class="icon-caret" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-541.85l-184,184L253.85-400L480-626.15L706.15-400L664-357.85l-184-184Z"></path></svg>`;
  const UNDO_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6.5H10C11.933 6.5 13.5 8.067 13.5 10C13.5 11.933 11.933 13.5 10 13.5H6M4 6.5L6.8 3.7M4 6.5L6.8 9.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const WIDGET_CSS = `
    :host {
      --pe-fg: var(--secondary-foreground, #3f3f46);
      --pe-hover-bg: var(--secondary, rgba(10, 10, 12, 0.06));
      --pe-sep: var(--border, rgba(10, 10, 12, 0.08));
      --pe-card: var(--popover, var(--card, #ffffff));
      --pe-card-fg: var(--foreground, #0a0a0c);
      --pe-card-muted: var(--secondary-foreground, #52525b);
      --pe-card-border: var(--border, rgba(10, 10, 12, 0.08));
      --pe-item-hover: var(--secondary, rgba(10, 10, 12, 0.05));
      --pe-item-active: var(--secondary, rgba(10, 10, 12, 0.09));
      --pe-shadow: rgba(0, 0, 0, 0.10);
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      height: 28px;
      margin-left: 2px;
      position: relative;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 16px;
      font-weight: 400;
      color: var(--pe-fg);
      user-select: none;
    }
    :host([data-theme="dark"]) {
      --pe-fg: var(--secondary-foreground, #a1a1aa);
      --pe-hover-bg: var(--secondary, rgba(255, 255, 255, 0.07));
      --pe-sep: var(--border, rgba(255, 255, 255, 0.09));
      --pe-card: var(--popover, var(--card, #1e2024));
      --pe-card-fg: var(--foreground, #f4f4f5);
      --pe-card-muted: var(--secondary-foreground, #a1a1aa);
      --pe-card-border: var(--border, rgba(255, 255, 255, 0.10));
      --pe-item-hover: var(--secondary, rgba(255, 255, 255, 0.06));
      --pe-item-active: var(--secondary, rgba(255, 255, 255, 0.11));
      --pe-shadow: rgba(0, 0, 0, 0.45);
    }
    * { box-sizing: border-box; }
    .pill-group {
      display: inline-flex;
      align-items: center;
      height: 28px;
      border-radius: 9999px;
      background: transparent;
      border: 0;
    }
    button {
      font: inherit;
      color: var(--pe-fg);
      background: transparent;
      border: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      padding: 0 6px;
      white-space: nowrap;
      line-height: 16px;
      outline: none;
      transition: background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), color 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    }
    button:hover {
      background: var(--pe-hover-bg);
    }
    .btn-enhance {
      padding-left: 7px;
      padding-right: 5px;
      border-top-left-radius: 9999px;
      border-bottom-left-radius: 9999px;
    }
    .btn-model {
      padding-left: 4px;
      padding-right: 4px;
      gap: 2px;
      border-top-right-radius: 9999px;
      border-bottom-right-radius: 9999px;
    }
    .btn-model .model-sub {
      opacity: 0.72;
    }
    .sep-dot {
      width: 1px;
      height: 12px;
      background: var(--pe-sep);
      flex: none;
    }
    .btn-undo {
      height: 28px;
      margin-left: 1px;
      padding: 0 6px;
      border-radius: 9999px;
      opacity: 0.8;
    }
    .btn-undo:hover {
      opacity: 1;
    }
    .btn-undo[hidden] { display: none; }
    svg { flex: none; }
    .icon-spin { animation: pe-spin 0.85s linear infinite; }
    @keyframes pe-spin { to { transform: rotate(360deg); } }

    .toast {
      position: fixed;
      z-index: 2147483646;
      padding: 6px 11px;
      border-radius: 8px;
      background: var(--pe-card);
      color: var(--pe-card-fg);
      border: 1px solid var(--pe-card-border);
      box-shadow: 0 6px 20px var(--pe-shadow);
      font-size: 11.5px;
      pointer-events: none;
      white-space: nowrap;
      transition: opacity 0.18s ease;
    }
    .toast[hidden] { display: none; }

    .popover-card {
      position: fixed;
      inset: auto;
      margin: 0;
      z-index: 2147483645;
      width: 288px;
      padding: 10px;
      border-radius: 12px;
      background: var(--pe-card);
      color: var(--pe-card-fg);
      border: 1px solid var(--pe-card-border);
      box-shadow: 0 8px 28px var(--pe-shadow);
      font-size: 12px;
    }
    .popover-card[hidden] { display: none; }
    .popover-card::backdrop { background: transparent; pointer-events: none; }
    .sec-title {
      font-size: 11px;
      font-weight: 500;
      color: var(--pe-card-muted);
      opacity: 0.8;
      margin: 0 0 6px;
      padding: 0 2px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .mode-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px;
      margin-bottom: 10px;
    }
    .mode-item {
      padding: 5px 8px;
      border-radius: 7px;
      border: 1px solid var(--pe-card-border);
      color: var(--pe-card-fg);
      font-size: 11.5px;
      justify-content: flex-start;
      height: auto;
    }
    .mode-item:hover { background: var(--pe-item-hover); }
    .mode-item[aria-checked="true"] {
      background: var(--pe-item-active);
      font-weight: 500;
    }
    .custom-box {
      margin-bottom: 10px;
    }
    .custom-box[hidden] { display: none; }
    .custom-box textarea {
      width: 100%;
      height: 54px;
      padding: 6px 8px;
      border-radius: 7px;
      border: 1px solid var(--pe-card-border);
      background: transparent;
      color: var(--pe-card-fg);
      font: inherit;
      font-size: 11px;
      resize: vertical;
      outline: none;
    }
    .model-list {
      max-height: 190px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding-right: 2px;
      border-top: 1px solid var(--pe-card-border);
      padding-top: 6px;
    }
    .model-opt {
      width: 100%;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 7px;
      color: var(--pe-card-fg);
      font-size: 12px;
      height: auto;
      text-align: left;
    }
    .model-opt:hover { background: var(--pe-item-hover); }
    .model-opt[aria-selected="true"] {
      background: var(--pe-item-active);
      font-weight: 500;
    }
    .foot-tip {
      margin-top: 8px;
      padding-top: 7px;
      border-top: 1px solid var(--pe-card-border);
      font-size: 10.5px;
      color: var(--pe-card-muted);
      opacity: 0.75;
      display: flex;
      justify-content: space-between;
    }
  `;

  function currentModelShortLabel() {
    const found = state.models.find(m => m.id === state.selectedModel);
    return found ? found.shortLabel : 'Flash 3.8 低';
  }

  function showToast(msg, duration = 2600) {
    if (!shadow) return;
    const toast = shadow.getElementById('pe-toast');
    const btn = shadow.getElementById('pe-btn-enhance');
    if (!toast || !btn) return;
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.hidden = false;
    const rect = btn.getBoundingClientRect();
    toast.style.left = `${Math.max(12, Math.min(window.innerWidth - 260, rect.left))}px`;
    toast.style.top = `${Math.max(12, rect.top - 36)}px`;
    toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function positionPopover() {
    if (!shadow || !menuOpen) return;
    const card = shadow.getElementById('pe-popover');
    const trigger = shadow.getElementById('pe-btn-model');
    if (!card || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 300;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left - 40));
    card.style.left = `${left}px`;
    const cardHeight = card.offsetHeight || 340;
    const useAbove = rect.top > cardHeight + 16 || rect.top >= window.innerHeight - rect.bottom;
    card.style.top = useAbove
      ? `${Math.max(12, rect.top - cardHeight - 8)}px`
      : `${Math.min(window.innerHeight - cardHeight - 12, rect.bottom + 8)}px`;
  }

  function togglePopover(force) {
    if (!shadow) return;
    const card = shadow.getElementById('pe-popover');
    if (!card) return;
    menuOpen = typeof force === 'boolean' ? force : !menuOpen;
    if (menuOpen) {
      renderPopoverContent();
      card.hidden = false;
      if (typeof card.showPopover === 'function' && !card.matches(':popover-open')) {
        try { card.showPopover(); } catch {}
      }
      positionPopover();
    } else {
      if (typeof card.hidePopover === 'function' && card.matches(':popover-open')) {
        try { card.hidePopover(); } catch {}
      }
      card.hidden = true;
    }
  }

  function saveLocalState() {
    try {
      localStorage.setItem('ag-pe-model', state.selectedModel);
      localStorage.setItem('ag-pe-mode', state.selectedMode);
      localStorage.setItem('ag-pe-custom', state.customSystemPrompt || '');
    } catch {}
    window.agPromptEnhancerHost?.savePrefs?.({
      selectedModel: state.selectedModel,
      selectedMode: state.selectedMode,
      customSystemPrompt: state.customSystemPrompt,
    });
  }

  function renderPill() {
    if (!shadow) return;
    hostNode.dataset.theme = detectTheme();
    const btnEnhance = shadow.getElementById('pe-btn-enhance');
    const btnModel = shadow.getElementById('pe-btn-model');
    const btnUndo = shadow.getElementById('pe-btn-undo');
    if (btnEnhance) {
      btnEnhance.innerHTML = busy
        ? `${SPINNER_SVG}<span>优化中…</span>`
        : `${SPARKLE_SVG}<span>增强</span>`;
      btnEnhance.title = busy
        ? '正在调用大模型优化提示词，点击可取消'
        : `使用 [${currentModelShortLabel()}] 一键优化输入框中的提示词 (Alt+E)`;
    }
    if (btnModel) {
      btnModel.innerHTML = `<span class="model-sub">${currentModelShortLabel()}</span>${CARET_SVG}`;
      btnModel.title = '选择提示词优化所用的大模型与增强风格';
    }
    if (btnUndo) {
      btnUndo.hidden = !undoText || busy;
      btnUndo.title = '还原为优化前的原始提示词';
    }
  }

  function renderPopoverContent() {
    if (!shadow) return;
    const modeGrid = shadow.getElementById('pe-mode-grid');
    const customBox = shadow.getElementById('pe-custom-box');
    const customInput = shadow.getElementById('pe-custom-input');
    const modelList = shadow.getElementById('pe-model-list');
    if (modeGrid) {
      modeGrid.replaceChildren(...state.modes.map(m => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mode-item';
        b.textContent = m.label;
        b.title = m.desc;
        b.setAttribute('aria-checked', String(m.id === state.selectedMode));
        b.addEventListener('click', () => {
          state.selectedMode = m.id;
          saveLocalState();
          renderPopoverContent();
          positionPopover();
        });
        return b;
      }));
    }
    if (customBox && customInput) {
      customBox.hidden = state.selectedMode !== 'custom';
      if (customInput.value !== state.customSystemPrompt) {
        customInput.value = state.customSystemPrompt;
      }
    }
    if (modelList) {
      modelList.replaceChildren(...state.models.map(m => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'model-opt';
        const active = m.id === state.selectedModel;
        b.setAttribute('aria-selected', String(active));
        b.innerHTML = `<span>${m.label}</span><span>${active ? '✓' : ''}</span>`;
        b.addEventListener('click', () => {
          state.selectedModel = m.id;
          saveLocalState();
          renderPill();
          renderPopoverContent();
          setTimeout(() => togglePopover(false), 120);
        });
        return b;
      }));
    }
  }

  async function runEnhance() {
    if (!currentComposer?.editor) return;
    if (busy) {
      activeReqId++;
      busy = false;
      renderPill();
      showToast('已取消提示词优化');
      return;
    }
    const rawText = readEditorText(currentComposer.editor).trim();
    if (!rawText) {
      showToast('💡 请先在输入框中输入需要优化的提示词');
      currentComposer.editor.focus();
      return;
    }
    togglePopover(false);
    busy = true;
    const reqId = ++activeReqId;
    renderPill();

    const hostModelText = currentComposer.modelBtn?.getAttribute('aria-label') || currentComposer.modelBtn?.textContent || '';
    try {
      const res = await window.agPromptEnhancerHost.enhance({
        text: rawText,
        model: state.selectedModel,
        hostModelText,
        mode: state.selectedMode,
        customSystemPrompt: state.customSystemPrompt,
      });
      if (reqId !== activeReqId) return;
      busy = false;
      if (res?.error) {
        renderPill();
        showToast(`⚠️ ${res.error}`, 3500);
        return;
      }
      if (res?.enhancedText) {
        undoText = rawText;
        redoText = res.enhancedText;
        writeEditorText(currentComposer.editor, res.enhancedText);
        renderPill();
        const sec = ((res.elapsedMs || 0) / 1000).toFixed(1);
        showToast(`✨ 已由 ${res.modelLabel || currentModelShortLabel()} 增强 (${sec}s)`);
      }
    } catch (e) {
      if (reqId !== activeReqId) return;
      busy = false;
      renderPill();
      showToast(`⚠️ 优化失败: ${e.message || '请重试'}`, 3500);
    }
  }

  function runUndo() {
    if (!undoText || !currentComposer?.editor) return;
    const current = readEditorText(currentComposer.editor);
    writeEditorText(currentComposer.editor, undoText);
    redoText = current;
    undoText = null;
    renderPill();
    showToast('↩ 已恢复优化前的原始提示词');
  }

  function mountWidget() {
    const found = findTargetComposer();
    if (!found) {
      if (hostNode) {
        hostNode.remove();
        hostNode = null;
        shadow = null;
        currentComposer = null;
      }
      return;
    }
    currentComposer = found;
    for (let el = found.modelBtn; el && el !== found.branch; el = el.parentElement) {
      if (el.style && el.style.flexShrink !== '0') el.style.flexShrink = '0';
    }
    if (hostNode && hostNode.isConnected && hostNode.previousElementSibling === found.modelWrap) {
      hostNode.dataset.theme = detectTheme();
      return;
    }
    if (!hostNode) {
      hostNode = document.createElement('div');
      hostNode.id = HOST_ID;
      shadow = hostNode.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>${WIDGET_CSS}</style>
        <div class="pill-group">
          <button type="button" class="btn-enhance" id="pe-btn-enhance"></button>
          <span class="sep-dot" aria-hidden="true"></span>
          <button type="button" class="btn-model" id="pe-btn-model" aria-haspopup="listbox"></button>
        </div>
        <button type="button" class="btn-undo" id="pe-btn-undo" hidden>${UNDO_SVG}<span>还原</span></button>
        <div class="toast" id="pe-toast" hidden></div>
        <section class="popover-card" id="pe-popover" hidden>
          <div class="sec-title"><span>✨ 提示词增强模式</span></div>
          <div class="mode-grid" id="pe-mode-grid"></div>
          <div class="custom-box" id="pe-custom-box" hidden>
            <textarea id="pe-custom-input" placeholder="输入自定义优化要求（例如：突出安全审计要求、输出分点需求文档…）"></textarea>
          </div>
          <div class="sec-title"><span>🤖 选择优化所用大模型</span></div>
          <div class="model-list" id="pe-model-list" role="listbox"></div>
          <div class="foot-tip"><span>快捷键: Alt + E 立即增强</span><span>点 ↩ 一键还原</span></div>
        </section>
      `;
      const popover = shadow.getElementById('pe-popover');
      if (popover && typeof popover.showPopover === 'function') {
        popover.setAttribute('popover', 'manual');
      }
      for (const ev of ['pointerdown', 'mousedown', 'click']) {
        shadow.addEventListener(ev, e => e.stopPropagation());
      }
      shadow.getElementById('pe-btn-enhance').addEventListener('click', () => void runEnhance());
      shadow.getElementById('pe-btn-model').addEventListener('click', () => togglePopover());
      shadow.getElementById('pe-btn-undo').addEventListener('click', () => runUndo());
      const customInput = shadow.getElementById('pe-custom-input');
      customInput.addEventListener('input', () => {
        state.customSystemPrompt = customInput.value;
        saveLocalState();
      });
    }
    found.modelWrap.after(hostNode);
    renderPill();
  }

  const onDocClick = e => {
    if (menuOpen && hostNode && !e.composedPath().includes(hostNode)) {
      togglePopover(false);
    }
  };
  const onKeyDown = e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'e') {
      if (currentComposer?.editor) {
        e.preventDefault();
        void runEnhance();
      }
    } else if (e.key === 'Escape' && menuOpen) {
      togglePopover(false);
    }
  };
  document.addEventListener('pointerdown', onDocClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  async function syncBackendInit() {
    try {
      const init = await window.agPromptEnhancerHost.init();
      if (init?.models?.length) state.models = init.models;
      if (init?.prefs) {
        if (init.prefs.selectedModel) state.selectedModel = init.prefs.selectedModel;
        if (init.prefs.selectedMode) state.selectedMode = init.prefs.selectedMode;
        if (typeof init.prefs.customSystemPrompt === 'string') state.customSystemPrompt = init.prefs.customSystemPrompt;
      }
      renderPill();
    } catch {}
  }

  mountWidget();
  void syncBackendInit();
  const timer = setInterval(mountWidget, 800);
  const obs = new MutationObserver(() => mountWidget());
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });

  window.__agPromptEnhancerDispose = () => {
    clearInterval(timer);
    obs.disconnect();
    document.removeEventListener('pointerdown', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hostNode?.remove();
    hostNode = null;
    shadow = null;
    delete window.__agPromptEnhancerInstalled;
  };
};
