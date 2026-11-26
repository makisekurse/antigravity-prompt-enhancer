import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeShortLabel,
  assignModelIcon,
  matchModelByHostText,
  cleanEnhancedOutput,
  buildEnhancementPrompt,
  EnhancerService,
  DEFAULT_MODELS,
} from '../sidecars/enhancer/enhancer-service.mjs';

test('makeShortLabel handles legacy, new Gemini 4 series, XHigh, and Orchestrator without truncation', () => {
  assert.equal(makeShortLabel('Gemini 3.8 Flash (Low)'), 'Flash 3.8 低');
  assert.equal(makeShortLabel('Gemini 4 Argon (High)'), 'Argon 4 高');
  assert.equal(makeShortLabel('Gemini 4 Neon (XHigh)'), 'Neon 4 超高');
  assert.equal(makeShortLabel('Gemini 4 Neon (High)'), 'Neon 4 高');
  assert.equal(makeShortLabel('Gemini 4 Carbon (Medium)'), 'Carbon 4 中');
  assert.equal(makeShortLabel('Gemini 4 Hydrogen (Medium)'), 'Hydrogen 4 中');
  assert.equal(makeShortLabel('Gemini 4 Hydrogen (XHigh)'), 'Hydrogen 4 超高');
  assert.equal(makeShortLabel('Orchestrator (Neon)'), 'Orch Neon');
  assert.equal(makeShortLabel('Claude Sonnet 5.5 (High)'), 'Sonnet 5.5 高');
  assert.equal(makeShortLabel('Claude Opus 5.5 (Medium)'), 'Opus 5.5 中');
  assert.equal(makeShortLabel('GPT-OSS 120B (Medium)'), 'GPT-120B 中');
});

test('assignModelIcon assigns distinct icons for new model families', () => {
  assert.equal(assignModelIcon('Gemini 4 Neon (XHigh)'), '✨');
  assert.equal(assignModelIcon('Gemini 4 Carbon (High)'), '💎');
  assert.equal(assignModelIcon('Gemini 4 Hydrogen (Medium)'), '💧');
  assert.equal(assignModelIcon('Orchestrator (Neon)'), '🎼');
  assert.equal(assignModelIcon('Gemini 3.8 Flash (Low)'), '⚡');
});

test('matchModelByHostText strictly separates XHigh from High', () => {
  const models = [
    { id: '__follow_current__', label: '跟随当前' },
    { id: 'M_NEON_HIGH', rawLabel: 'Gemini 4 Neon (High)' },
    { id: 'M_NEON_XHIGH', rawLabel: 'Gemini 4 Neon (XHigh)' },
    { id: 'M_HYD_MED', rawLabel: 'Gemini 4 Hydrogen (Medium)' },
  ];
  assert.equal(matchModelByHostText(models, 'Select model, current: Gemini 4 Neon XHigh')?.id, 'M_NEON_XHIGH');
  assert.equal(matchModelByHostText(models, 'Gemini 4 Neon 超高')?.id, 'M_NEON_XHIGH');
  assert.equal(matchModelByHostText(models, 'Gemini 4 Neon 高')?.id, 'M_NEON_HIGH');
  assert.equal(matchModelByHostText(models, 'Gemini 4 Hydrogen 中')?.id, 'M_HYD_MED');
});

test('cleanEnhancedOutput strips conversational wrappers, XML tags, and code fences while preserving placeholders', () => {
  assert.equal(
    cleanEnhancedOutput('好的，优化后的提示词如下：\n\n```markdown\n请检查 {{MENTION_0}} 的性能\n```'),
    '请检查 {{MENTION_0}} 的性能',
  );
  assert.equal(
    cleanEnhancedOutput('<enhanced_prompt>\n简明输出\n</enhanced_prompt>'),
    '简明输出',
  );
  assert.equal(
    cleanEnhancedOutput("Here's the enhanced prompt:\nRefactor auth flow."),
    'Refactor auth flow.',
  );
});

test('buildEnhancementPrompt enforces concise length cap and XML isolation without conflicting expansion instructions', () => {
  const concisePrompt = buildEnhancementPrompt({
    rawInput: '帮我看看这个账本',
    modeId: 'concise',
    hasMentions: true,
  });
  assert.ok(concisePrompt.includes('<user_draft>\n帮我看看这个账本\n</user_draft>'));
  assert.ok(concisePrompt.includes('严禁大幅扩写'));
  assert.ok(!concisePrompt.includes('改写并扩充为'));
  assert.ok(concisePrompt.includes('{{MENTION_0}}'));
});

test('savePreferences serializes concurrent writes atomically without corrupting JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pe-test-'));
  try {
    const prefsFile = join(dir, 'preferences.json');
    const svc = new EnhancerService({ paths: { prefsFile } });
    await Promise.all([
      svc.savePreferences({ selectedModel: 'MODEL_A' }),
      svc.savePreferences({ selectedMode: 'coding' }),
      svc.savePreferences({ customSystemPrompt: '规则 1' }),
      svc.savePreferences({ customSystemPrompt: '规则最终版' }),
    ]);
    const finalPrefs = await svc.loadPreferences();
    assert.equal(finalPrefs.selectedModel, 'MODEL_A');
    assert.equal(finalPrefs.selectedMode, 'coding');
    assert.equal(finalPrefs.customSystemPrompt, '规则最终版');
    const raw = JSON.parse(await readFile(prefsFile, 'utf8'));
    assert.equal(raw.customSystemPrompt, '规则最终版');
    await svc.savePreferences({ history: [{ original: 'a', enhanced: 'b' }] });
    await svc.clearHistory();
    assert.deepEqual((await svc.loadPreferences()).history, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_MODELS contains valid entries and follow_current sentinel', () => {
  assert.equal(DEFAULT_MODELS[0].id, '__follow_current__');
  assert.ok(DEFAULT_MODELS.some(m => m.id === 'MODEL_PLACEHOLDER_M535'));
});
