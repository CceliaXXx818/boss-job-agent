// V0.5 Phase 3 测试组 B/H/I/J/K：Runtime 恢复、Pause/Resume、风险暂停、SW 中断幂等
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeChrome, installChrome } from './helpers/chrome-stub.js';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import {
  AUTOPILOT_STATUS,
  AUTOPILOT_STEPS,
  RUNTIME_KEY,
  loadRuntime,
  patchRuntime,
} from '../../../extension/autopilot-runtime.js';
import { EVENT_TYPES, getEventDates, getEventsByDate, localDateKey } from '../../../extension/event-store.js';
import { getActions, markExecuting, getAllActions } from '../../../extension/action-queue.js';
import { getJobState } from '../../../extension/job-state.js';

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

async function allEventsByType(type: string) {
  const out = [];
  for (const d of await getEventDates()) {
    for (const e of await getEventsByDate(d)) if (e.type === type) out.push(e);
  }
  return out;
}

describe('B. Runtime Recovery（SW 被回收后从 storage 续跑）', () => {
  it('启动 → persist → 模拟 SW restart → reload → 能从原步骤继续', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })], replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });

    // 推进若干步后"SW 被回收"
    await h.engine.advanceAutopilot(); // PLAN
    await h.engine.advanceAutopilot(); // SEARCH
    const before = await loadRuntime();
    expect(before.currentPlan).toBeTruthy();
    expect(before.step).not.toBe(AUTOPILOT_STEPS.PLAN);
    const snapshot = h.snapshot();

    // 重建 chrome 桩（等价于 SW 重启后重新读 storage）
    installChrome(makeChrome(snapshot));
    const restored = await loadRuntime();
    expect(restored.step).toBe(before.step);
    expect(restored.currentPlan?.queries?.length).toBe(before.currentPlan?.queries?.length);
    expect(restored.searchQueries ?? restored.searchedQueries).toEqual(before.searchedQueries);

    // 续跑：不需要用户打开 Side Panel，直接继续到收工
    const run = await h.runUntil(done, { maxSteps: 80 });
    expect(run.reached).toBe(true);
    expect(h.calls.greet).toEqual(['j-1']);
    expect((await loadRuntime()).status).toBe(AUTOPILOT_STATUS.MONITORING);
  });

  it('部分搜索结果已持久化时，重启不会重复搜索同一个关键词', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 88 })], planQueries: ['AI产品经理', 'AI平台产品经理'] },
      { maxDiscoveryRounds: 1 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    await h.engine.advanceAutopilot(); // SEARCH #1
    const afterFirst = await loadRuntime();
    expect(afterFirst.searchedQueries).toHaveLength(1);
    installChrome(makeChrome(h.snapshot()));

    const run = await h.runUntil(done, { maxSteps: 80 });
    expect(run.reached).toBe(true);
    // 每个关键词只搜一次
    expect(h.calls.search.filter((k) => k === 'AI产品经理')).toHaveLength(1);
    expect(h.calls.search.filter((k) => k === 'AI平台产品经理')).toHaveLength(1);
  });

  it('跨天恢复：昨天的 session 会被重置为今天的新 Session（不会带着昨天的轮次继续）', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })], now: new Date('2026-09-13T10:00:00') });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot();
    h.setNow(new Date('2026-09-14T10:05:00'));

    const r = await h.engine.advanceAutopilot();
    expect(r.status).toBe(AUTOPILOT_STATUS.PLANNING);
    const rt = await loadRuntime();
    expect(rt.date).toBe('2026-09-14');
    expect(rt.roundIndex).toBe(1);
    expect(rt.searchedQueries).toEqual([]);
    expect(rt.log.some((l: { text: string }) => l.text.includes('跨天'))).toBe(true);
  });
});

describe('H. Pause（暂停后不 Search / 不 Greeting）', () => {
  it('PAUSED 后 advance 不再产生任何浏览器动作', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    const searchesBefore = h.calls.search.length;

    const paused = await h.engine.pauseByUser();
    expect(paused.ok).toBe(true);
    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('用户暂停');
    expect(rt.lastRisk).toBe('USER_PAUSED'); // 机器可读原因

    for (let i = 0; i < 5; i++) {
      const r = await h.engine.advanceAutopilot();
      expect(r.advanced).toBe(false);
      expect(r.status).toBe(AUTOPILOT_STATUS.PAUSED);
    }
    expect(h.calls.search).toHaveLength(searchesBefore);
    expect(h.calls.greet).toEqual([]);

    const pausedEvents = await allEventsByType(EVENT_TYPES.AUTOPILOT_PAUSED);
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0].metadata.reason).toBe('用户暂停');
  });

  it('暂停时正在执行的动作不会被"中途再点一次"（只允许当前 bounded action 结束）', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    // 推进到 approvals 已创建的阶段
    const run = await h.runUntil(async (rt) => (rt.outreachQueue ?? []).length > 0, { maxSteps: 60 });
    expect(run.reached).toBe(true);
    const before = h.calls.greet.length;
    await h.engine.pauseByUser();
    await h.engine.advanceAutopilot();
    await h.engine.advanceAutopilot();
    expect(h.calls.greet).toHaveLength(before); // 暂停后不再发送
    const actions = await getAllActions();
    expect(actions.every((a) => a.status !== 'executing')).toBe(true);
  });
});

describe('I. Resume（条件合法才恢复；条件失效保持 PAUSED）', () => {
  it('条件合法 → RESUMED 事件 + 继续推进到收工', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })], replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot();
    await h.engine.pauseByUser();

    const resumed = await h.engine.resumeAutopilot();
    expect(resumed.ok).toBe(true);
    expect((await loadRuntime()).paused).toBe(false);

    const run = await h.runUntil(done, { maxSteps: 80 });
    expect(run.reached).toBe(true);
    expect(h.calls.greet).toEqual(['j-1']);
    expect(await allEventsByType(EVENT_TYPES.AUTOPILOT_RESUMED)).toHaveLength(1);
  });

  it('工作时间已过 → Resume 失败并保持 PAUSED（带原因）', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 88 })], now: new Date('2026-09-13T10:00:00') },
      { workingHours: { start: '09:00', end: '18:00' } },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.pauseByUser();
    h.setNow(new Date('2026-09-13T21:00:00'));

    const res = await h.engine.resumeAutopilot();
    expect(res.ok).toBe(false);
    expect(res.code).toBe('OUTSIDE_WORKING_HOURS');
    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(rt.paused).toBe(true);
  });

  it('授权被撤销 / 模式改回 Review → Resume 失败', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.pauseByUser();
    await h.chromeStub.storage.local.set({
      jobAgentSettings: autopilotSettings({ mode: 'review', consent: { autopilot: false, autopilotAt: null, autoResume: false, autoResumeAt: null } }),
    });
    const res = await h.engine.resumeAutopilot();
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MODE_INVALID');
    expect((await loadRuntime()).status).toBe(AUTOPILOT_STATUS.PAUSED);
  });

  it('cap 已满时 Resume → 直接收工到 MONITORING', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] }, { dailyGreetingCap: 2 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.pauseByUser();
    await h.chromeStub.storage.local.set({ [`greet-${h.dateKey()}`]: 2 });
    const res = await h.engine.resumeAutopilot();
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('DAILY_CAP_REACHED');
    expect((await loadRuntime()).status).toBe(AUTOPILOT_STATUS.MONITORING);
  });

  it('未暂停时 Resume 无效', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const res = await h.engine.resumeAutopilot();
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_PAUSED');
  });
});

describe('J. Risk → PAUSED', () => {
  it('搜索遇到验证码 → PAUSED(CAPTCHA)，不再继续', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    h.browser.search = async () => ({ ok: false, risk: 'CAPTCHA', reason: '检测到验证码/安全校验页面' });

    const r = await h.engine.advanceAutopilot();
    expect(r.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(r.code).toBe('CAPTCHA');
    const rt = await loadRuntime();
    expect(rt.pauseReason).toContain('验证码');
    expect(h.calls.greet).toEqual([]);
    const paused = await allEventsByType(EVENT_TYPES.AUTOPILOT_PAUSED);
    expect(paused.at(-1)?.metadata.code).toBe('CAPTCHA');
  });

  it('登录失效 → PAUSED(LOGIN_REQUIRED)', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot();
    h.browser.search = async () => ({ ok: false, risk: 'LOGIN_REQUIRED', reason: 'BOSS 登录状态已失效' });
    const r = await h.engine.advanceAutopilot();
    expect(r.code).toBe('LOGIN_REQUIRED');
    expect((await loadRuntime()).status).toBe(AUTOPILOT_STATUS.PAUSED);
  });

  it('AI 服务不可用 → PAUSED(AI_SERVICE_UNAVAILABLE)', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    h.ai.planSearch = async () => ({ ok: false, error: 'AI 服务未连接', code: 'AI_SERVICE_UNAVAILABLE' });
    const r = await h.engine.advanceAutopilot();
    expect(r.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(r.code).toBe('AI_SERVICE_UNAVAILABLE');
    expect((await loadRuntime()).pauseReason).toContain('AI 服务未连接');
  });

  it('连续浏览器工具失败达到阈值 → PAUSED(BROWSER_TOOL_FAILURE_THRESHOLD)', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    h.browser.search = async () => ({ ok: false, error: '模拟搜索失败' });

    const first = await h.engine.advanceAutopilot();
    expect(first.status).not.toBe(AUTOPILOT_STATUS.PAUSED); // 第一次失败不直接暂停（允许一次安全重试）
    const second = await h.engine.advanceAutopilot();
    expect(second.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(second.code).toBe('BROWSER_TOOL_FAILURE_THRESHOLD');
    expect((await loadRuntime()).consecutiveToolFailures).toBeGreaterThanOrEqual(2);
  });

  it('打招呼时遇到风险 → Action 变 requires_manual 且不写 GREETING_SENT', async () => {
    const h = makeHarness({
      jobs: [makeJob({ jobId: 'j-1', score: 88 })],
      greetResults: [{ ok: false, risk: 'CAPTCHA', reason: '打招呼时遇到验证码' }],
    });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil((rt) => rt.status === AUTOPILOT_STATUS.PAUSED, { maxSteps: 80 });
    expect(run.reached).toBe(true);

    const actions = await getActions({ type: 'GREETING' });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('requires_manual');
    expect(await allEventsByType(EVENT_TYPES.GREETING_SENT)).toHaveLength(0);
    expect((await getJobState('j-1'))?.state ?? null).not.toBe('GREETED');
  });
});

describe('K. SW interruption（Release Blocking Requirement）', () => {
  it('Greeting 执行中断（executing 未回写）→ 重启后 requires_manual，绝不重复发送', async () => {
    const h = makeHarness({
      jobs: [makeJob({ jobId: 'j-1', score: 88 })],
      replanResponses: [{ ok: true, status: 'complete', newQueries: [] }],
    });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });

    // 推进到 Action 已 approved（再下一个 tick 才会 markExecuting + greet）
    const staged = await h.runUntil(
      async () => (await getActions({ type: 'GREETING' })).some((a) => a.status === 'approved'),
      { maxSteps: 60 },
    );
    expect(staged.reached).toBe(true);
    const actionId = (await getActions({ type: 'GREETING' }))[0].actionId;

    // 模拟"浏览器操作已经发出，但 JS 在回写前被 SW 终止"：Action 停在 executing
    const moved = await markExecuting(actionId);
    expect(moved.ok).toBe(true);
    await patchRuntime((r) => ({ ...r, activeActionId: actionId }));
    const snapshot = h.snapshot();
    expect(snapshot['jobAgentActions']).toBeTruthy();

    // SW 重启
    installChrome(makeChrome(snapshot));
    const recovered = await h.engine.recoverInterrupted();
    expect(recovered.recovered).toBe(1);

    const actions = await getActions({ type: 'GREETING' });
    expect(actions[0].status).toBe('requires_manual');
    expect(actions[0].manualReason).toContain('执行中断');
    expect((await loadRuntime()).activeActionId).toBeNull();

    // 恢复后即使继续推进 tick，也绝不再发送
    const before = h.calls.greet.length;
    for (let i = 0; i < 10; i++) await h.engine.advanceAutopilot();
    expect(h.calls.greet).toHaveLength(before);
    expect(await allEventsByType(EVENT_TYPES.GREETING_SENT)).toHaveLength(0);
    expect((await getJobState('j-1'))?.state ?? null).not.toBe('GREETED');
  });

  it('已经 success 的 Action 跨重启保持 success，不会被再次执行', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })], replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 80 });
    expect(h.calls.greet).toEqual(['j-1']);

    installChrome(makeChrome(h.snapshot()));
    await h.engine.recoverInterrupted();
    for (let i = 0; i < 5; i++) await h.engine.advanceAutopilot();
    expect(h.calls.greet).toEqual(['j-1']);
    expect(await allEventsByType(EVENT_TYPES.GREETING_SENT)).toHaveLength(1);
  });

  it('Stop 不清空 Events / Job State / Action 历史', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })], replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 80 });
    const eventsBefore = (await allEventsByType(EVENT_TYPES.GREETING_SENT)).length;

    await h.engine.stopAutopilot();
    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.STOPPED);
    expect(rt[RUNTIME_KEY as never]).toBeUndefined();
    expect(await getActions()).toHaveLength(1);
    expect((await getJobState('j-1'))?.state).toBe('GREETED');
    expect((await allEventsByType(EVENT_TYPES.GREETING_SENT)).length).toBe(eventsBefore);
    expect(await allEventsByType(EVENT_TYPES.AUTOPILOT_STOPPED)).toHaveLength(1);
  });
});

describe('Resume 必须重置连续失败计数（否则恢复后一次偶发失败就再次暂停）', () => {
  it('失败 2 次暂停 → Resume 后计数归零 → 再失败 1 次不会立即暂停', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 88 })] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN
    h.browser.search = async () => ({ ok: false, error: '模拟搜索失败' });

    await h.engine.advanceAutopilot(); // 失败 1
    const second = await h.engine.advanceAutopilot(); // 失败 2 → PAUSED
    expect(second.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect((await loadRuntime()).consecutiveToolFailures).toBeGreaterThanOrEqual(2);

    const resumed = await h.engine.resumeAutopilot();
    expect(resumed.ok).toBe(true);
    expect((await loadRuntime()).consecutiveToolFailures).toBe(0); // 关键：清零

    const afterOneMore = await h.engine.advanceAutopilot(); // 再失败 1 次
    expect(afterOneMore.status).not.toBe(AUTOPILOT_STATUS.PAUSED); // 不应立刻再暂停
    expect((await loadRuntime()).consecutiveToolFailures).toBe(1);
  });
});
