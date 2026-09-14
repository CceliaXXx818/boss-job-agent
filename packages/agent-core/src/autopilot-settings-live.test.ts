// V0.5 修复回归：Autopilot 必须按"当前设置"跑（settings 是唯一事实来源）
//
// 真实问题：用户改了 Autopilot 设置后重新 Start，感觉"没按新设置走"。
// 根因有两层：
//   ① Side Panel 的 Start 只发命令，**不保存设置表单** → 改了没点"保存设置"就 Start，新值根本没落盘；
//   ② 引擎里候选目标/阈值/每日上限/轮次/工作时间优先读**启动时的 runtime 快照**，
//      而 Policy 读实时 settings → 两个来源不一致时行为就像"没按新设置走"。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { getAllActions } from '../../../extension/action-queue.js';
import { EVENT_TYPES, getEventsByDate } from '../../../extension/event-store.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHarness(opts: HarnessOptions = {}, settingsOver: Record<string, unknown> = {}) {
  return createHarness({
    ...opts,
    initialStorage: { jobAgentSettings: autopilotSettings(settingsOver), ...(opts.initialStorage ?? {}) },
  });
}

const done = (rt: { status: string }) =>
  rt.status === AUTOPILOT_STATUS.MONITORING || rt.status === AUTOPILOT_STATUS.OUTREACH_COMPLETE;

describe('启动时会按当前设置跑，并把生效配置写清楚', () => {
  it('改设置后 Start：runtime / 事件 / 日志都反映新值', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 88 })] },
      { minimumAutoGreetingScore: 70, dailyGreetingCap: 3, batchQualifiedTarget: 4, maxDiscoveryRounds: 2, workingHours: { start: '09:00', end: '20:00' } },
    );
    const res = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(res.ok).toBe(true);

    const rt = await loadRuntime();
    expect(rt).toMatchObject({
      minimumAutoGreetingScore: 70,
      dailyGreetingCap: 3,
      batchQualifiedTarget: 4,
      maxDiscoveryRounds: 2,
    });
    expect(rt.workingHours).toEqual({ start: '09:00', end: '20:00' });

    // 启动横幅：用户能一眼核对"本次生效设置"
    const banner = rt.log.map((l: { text: string }) => l.text).find((t: string) => t.includes('本次生效设置'));
    expect(banner).toBeTruthy();
    expect(banner).toContain('阈值 70');
    expect(banner).toContain('每日上限 3');
    expect(banner).toContain('候选目标 4');
    expect(banner).toContain('09:00-20:00');

    // 事件 metadata 也记录生效配置
    const evs = await getEventsByDate(h.dateKey());
    const started = evs.find((e) => e.type === EVENT_TYPES.AUTOPILOT_STARTED);
    expect(started?.metadata).toMatchObject({
      minimumAutoGreetingScore: 70,
      batchQualifiedTarget: 4,
      workingHours: { start: '09:00', end: '20:00' },
    });
  });
});

describe('会话进行中改设置 → 之后的推进按新值（不再被启动快照卡住）', () => {
  it('把每日上限从 5 改到 1 → 只联系 1 个', async () => {
    const jobs = Array.from({ length: 3 }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 90 }));
    const h = makeHarness({ jobs }, { dailyGreetingCap: 5, minimumAutoGreetingScore: 80, batchQualifiedTarget: 2 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect((await loadRuntime()).dailyGreetingCap).toBe(5);

    // 模拟用户中途把上限改成 1（等价于保存设置）
    await chromeSetSetting(h, { dailyGreetingCap: 1 });

    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);
    expect(h.calls.greet).toHaveLength(1); // 按新上限
    expect((await loadRuntime()).todayGreetingCount).toBe(1);
  });

  it('把阈值从 60 提到 95 → 原本合格的候选不再被联系', async () => {
    const jobs = [makeJob({ jobId: 'j-1', score: 88 })];
    const h = makeHarness({ jobs }, { minimumAutoGreetingScore: 60, dailyGreetingCap: 2 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });

    await chromeSetSetting(h, { minimumAutoGreetingScore: 95 });

    await h.runUntil(done, { maxSteps: 200 });
    expect(h.calls.greet).toEqual([]); // 88 < 95 → 不联系
    expect(await getAllActions()).toEqual([]);
  });

  it('把工作时间改到当前时间之外 → 立即收工（不硬闯时间窗）', async () => {
    const jobs = [makeJob({ jobId: 'j-1', score: 90 })];
    const h = makeHarness({ jobs }, { workingHours: { start: '00:00', end: '23:59' } });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN

    await chromeSetSetting(h, { workingHours: { start: '22:00', end: '23:00' } }); // 当前 10:00 → 不在窗口

    const r = await h.engine.advanceAutopilot();
    expect(r.done).toBe(true);
    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
    expect(rt.log.map((l: { text: string }) => l.text).some((t: string) => t.includes('10:00') && t.includes('22:00-23:00'))).toBe(true);
  });

  it('把候选目标从 10 改到 2 → 用新目标判断"是否继续补搜"', async () => {
    const jobs = [makeJob({ jobId: 'j-1', score: 90 }), makeJob({ jobId: 'j-2', score: 88 })];
    const h = makeHarness(
      { jobs, replanResponses: [{ ok: true, status: 'continue', newQueries: [{ keyword: '不该被用到' }] }] },
      { batchQualifiedTarget: 10, minimumAutoGreetingScore: 80, dailyGreetingCap: 2 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });

    await chromeSetSetting(h, { batchQualifiedTarget: 2 }); // 2 个候选就够了

    await h.runUntil(done, { maxSteps: 200 });
    expect(h.calls.replan).toBe(0); // 达标 → skip Replan（按新目标）
    expect(h.calls.search).toEqual(['AI产品经理']);
  });
});

describe('Side Panel：Start 之前必须先把设置表单存下来', () => {
  const sidepanel = readFileSync(join(process.cwd(), 'extension', 'sidepanel.js'), 'utf8');
  const startBody = sidepanel.slice(
    sidepanel.indexOf("$('apStart').onclick"),
    sidepanel.indexOf("$('apPause').onclick"),
  );

  it('Start 处理里先 readSettingsForm + saveSettings', () => {
    expect(startBody).toContain('readSettingsForm()');
    expect(startBody).toContain('await saveSettings(');
    // 保存必须发生在发送 START_AUTOPILOT 之前
    expect(startBody.indexOf('saveSettings(')).toBeLessThan(startBody.indexOf("sendAutopilotCommand('START_AUTOPILOT'"));
  });

  it('启动后把生效配置显示给用户核对', () => {
    expect(startBody).toContain('本次生效：阈值');
  });
});

/** 直接改 storage 里的设置（等价于用户在面板上保存设置） */
async function chromeSetSetting(h: ReturnType<typeof createHarness>, patch: Record<string, unknown>) {
  const st = await h.chromeStub.storage.local.get('jobAgentSettings');
  const current = (st.jobAgentSettings ?? {}) as Record<string, unknown>;
  await h.chromeStub.storage.local.set({ jobAgentSettings: { ...current, ...patch } });
}
