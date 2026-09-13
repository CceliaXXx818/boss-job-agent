// V0.5 Phase 3：Manifest 权限（least privilege）与架构约束测试
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));

describe('Manifest：本阶段只新增真正需要的权限（V0.5 §2 / §42）', () => {
  it('permissions 精确等于允许集合（没有提前加通知/无限存储）', () => {
    expect([...manifest.permissions].sort()).toEqual(['alarms', 'downloads', 'sidePanel', 'storage', 'tabs'].sort());
  });

  it('没有 notifications / unlimitedStorage / scripting / webRequest', () => {
    for (const banned of ['notifications', 'unlimitedStorage', 'scripting', 'webRequest', 'declarativeNetRequest', 'cookies', 'history']) {
      expect(manifest.permissions).not.toContain(banned);
      expect(manifest.optional_permissions ?? []).not.toContain(banned);
    }
  });

  it('host_permissions 仍然只包含 BOSS 与本机 AI 服务', () => {
    expect(manifest.host_permissions).toEqual([
      'https://*.zhipin.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ]);
  });

  it('注册了 background service worker（ESM）', () => {
    expect(manifest.background).toMatchObject({ service_worker: 'background.js', type: 'module' });
  });

  it('manifest 版本为 0.5.0（V0.5 正式发布）', () => {
    expect(manifest.version).toBe('0.5.0');
  });

  it('content script 仍只注入 BOSS 域名，且未新增其它脚本', () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toEqual(['https://*.zhipin.com/*']);
    expect(manifest.content_scripts[0].js).toEqual(['content.js']);
  });
});

describe('Background SW 架构约束（V0.5 §1 / §3 / §4）', () => {
  const background = read('extension/background.js');
  // 只用于「禁止出现某种循环」这类断言：注释里出现 while(true)/setInterval 字样不算违规。
  // 做法：删掉块注释 + 整行行注释（不碰代码行内部的 //，避免被正则字面量干扰）。
  const code = background
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  it('实现全部 Side Panel 命令', () => {
    for (const cmd of [
      'START_AUTOPILOT',
      'PAUSE_AUTOPILOT',
      'RESUME_AUTOPILOT',
      'STOP_AUTOPILOT',
      'GET_AUTOPILOT_STATUS',
    ]) {
      expect(background).toContain(cmd);
    }
  });

  it('使用 chrome.alarms 做调度（而不是 setTimeout 长驻）', () => {
    expect(code).toMatch(/chrome\.alarms\.create/);
    expect(code).toMatch(/chrome\.alarms\.onAlarm\.addListener/);
  });

  it('监听 tabs 事件与 runtime 事件', () => {
    expect(code).toMatch(/chrome\.tabs\.onUpdated\.addListener/);
    expect(code).toMatch(/chrome\.runtime\.onMessage\.addListener/);
    expect(code).toMatch(/chrome\.runtime\.onStartup\.addListener/);
  });

  it('每次唤醒的推进步数是有界常量（不是无限循环）', () => {
    expect(code).toMatch(/MAX_STEPS_PER_WAKE\s*=\s*3/);
    expect(code).toMatch(/for \(let i = 0; i < steps; i\+\+\)/);
    expect(code).not.toMatch(/while \(true\)/); // 注释里提到过"没有 while(true)"，上面的块注释剥离保证不误判
    expect(code).not.toMatch(/setInterval/);
  });

  it('SW 重启时会先做中断恢复再续跑', () => {
    expect(code).toMatch(/recoverInterrupted\(\)/);
  });

  it('不猜 selector：所有页面操作都通过 content script 消息类型', () => {
    for (const msgType of ["'scrape'", "'detailScrape'", "'greetFull'", "'bossContext'", "'pageHealth'"]) {
      expect(background).toContain(msgType);
    }
    // Background 里不允许出现 querySelector / 直接 DOM 操作
    expect(background).not.toMatch(/querySelector|document\./);
  });

  it('Autopilot 只维护一个执行标签（不会每个 Job 开一个 tab）', () => {
    const creates = code.match(/chrome\.tabs\.create\(/g) ?? [];
    expect(creates).toHaveLength(1);
    expect(code).toMatch(/active: false/); // 不抢占用户当前标签
  });
});

describe('content.js 只新增只读的 pageHealth', () => {
  const content = read('extension/content.js');

  it('新增 pageHealth，且未新增任何点击/提交类行为', () => {
    expect(content).toContain("msg?.type === 'pageHealth'");
    expect(content).toContain('function pageHealth()');
    for (const banned of ['XMLHttpRequest', 'fetch(', 'localStorage.clear', 'removeItem']) {
      expect(content).not.toContain(banned);
    }
  });

  it('仍保留既有消息类型（未破坏 V0.4 行为）', () => {
    for (const msgType of ["'scrape'", "'greet'", "'greetFull'", "'detailScrape'", "'bossContext'", "'diagnose'"]) {
      expect(content).toContain(msgType);
    }
  });
});

describe('Review Mode 回归（Side Panel 流程未被 Phase 3 改变）', () => {
  const sidepanel = read('extension/sidepanel.js');

  it('Review 的六步链路仍在：Goal → Plan → Search → Replan → Shortlist → 用户确认 → Greeting', () => {
    for (const token of [
      'export async function runAgent',
      'async function runRound',
      'renderShortlist',
      'stageGreetingActions',
      'executeStagedActions',
      "'greetFull'",
    ]) {
      expect(sidepanel).toContain(token);
    }
  });

  it('Review 的发送仍然必须经过用户确认（approveActions 在 greetFull 之前）', () => {
    const body = sidepanel.slice(
      sidepanel.indexOf('async function executeStagedActions()'),
      sidepanel.indexOf('export async function renderAgentStatePanel'),
    );
    expect(body.indexOf('await approveActions(')).toBeLessThan(body.indexOf("type: 'greetFull'"));
  });

  it('Side Panel 只通过 chrome.runtime.sendMessage 指挥 Autopilot（自己不执行）', () => {
    expect(sidepanel).toMatch(/sendAutopilotCommand\(/);
    expect(sidepanel).toMatch(/chrome\.runtime\.sendMessage/);
    // Side Panel 不直接推进引擎
    expect(sidepanel).not.toMatch(/advanceAutopilot|createAutopilotEngine/);
  });

  it('Side Panel 通过 storage.onChanged 跟随 Background 状态', () => {
    expect(sidepanel).toMatch(/chrome\.storage\.onChanged\.addListener/);
  });

  it('Side Panel 仍然明确提示"关掉面板也会继续"与 MONITORING 的边界', () => {
    expect(sidepanel).toContain('关掉本面板也会继续运行');
    expect(sidepanel).toContain('HR 回复监测将在下一阶段启用');
  });
});
