// V0.5 Phase 3 修复回归：工作时间窗口的判定、提示与"日志时间显示"回归
// 背景：用户看到 Dashboard 里 10:01:15 就"超出工作时间"，实际那是 UTC 时间，
// 本地已经是 18:01 —— 判定本身正确，是显示用了 UTC 导致误解。这里把两件事都锁住。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { MIN_ROUND_WINDOW_MINUTES, minutesUntilWindowEnd } from '../../../extension/autopilot-engine.js';
import { isWithinWorkingHours } from '../../../extension/settings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHarness(opts: HarnessOptions = {}, settingsOver: Record<string, unknown> = {}) {
  return createHarness({
    ...opts,
    initialStorage: { jobAgentSettings: autopilotSettings(settingsOver), ...(opts.initialStorage ?? {}) },
  });
}

describe('minutesUntilWindowEnd（工作时间剩余量）', () => {
  it('日内窗口：返回剩余分钟数', () => {
    expect(minutesUntilWindowEnd('17:57', '09:00', '18:00')).toBe(3);
    expect(minutesUntilWindowEnd('09:00', '09:00', '18:00')).toBe(540);
    expect(minutesUntilWindowEnd('18:00', '09:00', '18:00')).toBe(0);
  });

  it('窗口外返回 0；跨夜窗口按 +24h 计算', () => {
    expect(minutesUntilWindowEnd('08:00', '09:00', '18:00')).toBe(0);
    expect(minutesUntilWindowEnd('19:00', '09:00', '18:00')).toBe(0);
    expect(minutesUntilWindowEnd('23:00', '22:00', '06:00')).toBe(420);
    expect(minutesUntilWindowEnd('05:00', '22:00', '06:00')).toBe(60);
  });

  it('非法输入返回 null（不阻断流程）', () => {
    expect(minutesUntilWindowEnd('bad', '09:00', '18:00')).toBeNull();
    expect(minutesUntilWindowEnd('10:00', null, null)).toBeNull();
  });

  it('与 isWithinWorkingHours 的边界一致（18:00 仍在窗口内，18:01 已超）', () => {
    expect(isWithinWorkingHours('18:00', '09:00', '18:00')).toBe(true);
    expect(isWithinWorkingHours('18:01', '09:00', '18:00')).toBe(false);
    expect(minutesUntilWindowEnd('18:00', '09:00', '18:00')).toBe(0);
    expect(minutesUntilWindowEnd('18:01', '09:00', '18:00')).toBe(0);
  });
});

describe('工作时间结束：收工原因必须可自解释（含本地时间与窗口）', () => {
  it('Round 跑到一半超过工作时间 → 收工信息里写明当前本地时间与工作时间区间', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 88 })], now: new Date('2026-09-13T17:55:00') },
      { workingHours: { start: '09:00', end: '18:00' } },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    await h.engine.advanceAutopilot(); // SEARCH（17:55 仍在窗口内）

    // 时间推进到 18:01（本地）→ 下一个 tick 必须收工并说明原因
    h.setNow(new Date('2026-09-13T18:01:00'));
    const r = await h.engine.advanceAutopilot();
    expect(r.done).toBe(true);
    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
    const last = rt.log[rt.log.length - 1];
    expect(last.text).toContain('已超出工作时间');
    expect(last.text).toContain('18:01'); // 当前本地时间
    expect(last.text).toContain('09:00-18:00'); // 生效的工作时间区间
    expect(h.calls.greet).toEqual([]);
  });

  it('超出工作时间后不会为了凑每日上限继续打招呼', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 95 })], now: new Date('2026-09-13T17:59:00') },
      { workingHours: { start: '09:00', end: '18:00' }, dailyGreetingCap: 5 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    h.setNow(new Date('2026-09-13T18:30:00'));
    await h.advance(5);
    expect(h.calls.greet).toEqual([]);
    expect((await loadRuntime()).todayGreetingCount).toBe(0);
  });
});

describe('启动时的工作时间提醒（不改执行规则，只提示）', () => {
  it('离结束不足 15 分钟 → 启动仍然成功，但返回 warning 并写进日志', async () => {
    const h = makeHarness({ now: new Date('2026-09-13T17:50:00') }, { workingHours: { start: '09:00', end: '18:00' } });
    const res = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(res.ok).toBe(true);
    expect(res.windowWarning).toContain('距离工作时间结束只剩 10 分钟');
    const rt = await loadRuntime();
    expect(rt.log.some((l: { text: string }) => l.text.includes('提醒'))).toBe(true);
    expect(h.activities.some((a) => a.includes('提醒'))).toBe(true);
  });

  it('时间充裕 → 不产生 warning', async () => {
    const h = makeHarness({ now: new Date('2026-09-13T10:00:00') }, { workingHours: { start: '09:00', end: '18:00' } });
    const res = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(res.ok).toBe(true);
    expect(res.windowWarning ?? null).toBeNull();
    expect(MIN_ROUND_WINDOW_MINUTES).toBe(15);
  });
});

describe('日志时间显示回归（不能再用 UTC 糊弄用户）', () => {
  const sidepanel = readFileSync(join(process.cwd(), 'extension', 'sidepanel.js'), 'utf8');

  it('Side Panel 用 formatLocalTime 渲染日志时间', () => {
    expect(sidepanel).toContain('export function formatLocalTime');
    expect(sidepanel).toMatch(/formatLocalTime\(l\.at\)/);
    // 不允许再把 ISO 字符串直接切片当时间显示
    expect(sidepanel).not.toMatch(/String\(l\.at\)\.slice\(11, 19\)/);
  });

  it('formatLocalTime 实现使用本地时区取值（getHours/getMinutes，而不是 toISOString）', () => {
    // sidepanel.js 依赖 DOM，无法在 Node 里 import，因此对实现做静态断言。
    const body = sidepanel.slice(
      sidepanel.indexOf('export function formatLocalTime'),
      sidepanel.indexOf('const todayKey'),
    );
    expect(body).toMatch(/d\.getHours\(\)/);
    expect(body).toMatch(/d\.getMinutes\(\)/);
    expect(body).not.toMatch(/toISOString/);
  });

  it('Dashboard 明确标注日志时间按本地时区显示', () => {
    const html = readFileSync(join(process.cwd(), 'extension', 'sidepanel.html'), 'utf8');
    expect(html).toContain('日志时间按你的本地时区显示');
  });

  it('getStatus 返回的日志窗口足够回溯一整轮（≥ 30 条）', () => {
    expect(sidepanel).toBeTruthy();
    const engine = readFileSync(join(process.cwd(), 'extension', 'autopilot-engine.js'), 'utf8');
    expect(engine).toMatch(/log: \(rt\.log \?\? \[\]\)\.slice\(-30\)/);
  });
});
