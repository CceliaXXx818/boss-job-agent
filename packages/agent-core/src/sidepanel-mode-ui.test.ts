// V0.5 Phase 3 交互：Autopilot 专属面板只在 Autopilot 模式显示
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'extension', 'sidepanel.html'), 'utf8');
const js = readFileSync(join(ROOT, 'extension', 'sidepanel.js'), 'utf8');
const css = readFileSync(join(ROOT, 'extension', 'sidepanel.css'), 'utf8');

const AUTOPILOT_PANELS = [
  'autopilotSettingsBox', // Autopilot 设置
  'greetingBox', // 打招呼话术
  'policyPreviewBox', // Policy 试算
  'autopilotDashboard', // Autopilot（状态 + 控制 + Activity）
  'agentStateBox', // 运行状态（Action Queue / 岗位状态 / 事件）
];

describe('HTML：五块 Autopilot 面板都在同一个可隐藏容器里', () => {
  const start = html.indexOf('<div id="autopilotPanels"');
  const endMarker = html.indexOf('<!-- ===== /Autopilot 面板 ===== -->');
  const body = html.slice(start, endMarker);

  it('容器存在且初始隐藏', () => {
    expect(start).toBeGreaterThan(-1);
    expect(endMarker).toBeGreaterThan(start);
    expect(html.slice(start, start + 40)).toContain('hidden');
  });

  it('五个面板都在容器内部', () => {
    for (const id of AUTOPILOT_PANELS) {
      expect(body, `${id} 应该在 autopilotPanels 容器内`).toContain(`id="${id}"`);
      // 容器外不应再出现同一 id
      const outside = html.slice(0, start) + html.slice(endMarker);
      expect(outside).not.toContain(`id="${id}"`);
    }
  });

  it('Review 必须保留的元素仍在容器外（模式选择 / 目标输入 / 开始 / 各状态区块）', () => {
    const outside = html.slice(0, start) + html.slice(endMarker);
    for (const id of ['modeReview', 'modeAutopilot', 'goalInput', 'startBtn', 'stateIdle', 'stateRunning', 'stateComplete']) {
      expect(outside, `${id} 不应该被 Autopilot 面板容器包住`).toContain(`id="${id}"`);
    }
  });

  it('policyPreviewBox 不再单独写死 hidden（由容器统一控制）', () => {
    expect(html).not.toMatch(/id="policyPreviewBox"[^>]*hidden/);
  });
});

describe('JS：renderModeUi 按模式切换面板可见性', () => {
  it('Autopilot 模式显示、Review 模式隐藏', () => {
    expect(js).toMatch(/\$\('autopilotPanels'\)\.hidden = mode !== 'autopilot'/);
  });

  it('不再单独切换 policyPreviewBox 的可见性', () => {
    expect(js).not.toMatch(/\$\('policyPreviewBox'\)\.hidden/);
  });

  it('切换模式后会刷新面板数据（避免显示空数据）', () => {
    const setModeBody = js.slice(js.indexOf('async function setMode(mode)'), js.indexOf('async function runPolicyPreview()'));
    expect(setModeBody).toContain('renderModeUi()');
    expect(setModeBody).toContain('await refreshAutopilotStatus()');
  });

  it('授权弹窗出现时，单选按钮回到"当前生效模式"（授权完成前不影响面板）', () => {
    const consentBody = js.slice(js.indexOf('function openConsent()'), js.indexOf('function closeConsent()'));
    expect(consentBody).toContain('renderModeUi()');
  });

  it('init 时先按设置渲染一次模式 UI（重开 Side Panel 状态不丢）', () => {
    const initStart = js.indexOf('async function init()');
    const initBody = js.slice(initStart, js.indexOf('\ninit();', initStart));
    expect(initBody.indexOf('session.settings = await loadSettings()')).toBeLessThan(initBody.indexOf('renderModeUi()'));
  });
});

describe('CSS：隐藏必须真的生效（防止 hidden 被 display 覆盖）', () => {
  it('有 #autopilotPanels[hidden] 的强制隐藏规则', () => {
    expect(css).toMatch(/#autopilotPanels\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });
});
