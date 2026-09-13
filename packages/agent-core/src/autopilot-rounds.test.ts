// V0.5 Phase 3 测试组 C/D/E/F/G：轮次、Daily Cap、Max Rounds、无新结果、跨轮 Dedupe
import { describe, it, expect, afterEach, vi } from 'vitest';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { EVENT_TYPES, getEventDates, getEventsByDate, localDateKey } from '../../../extension/event-store.js';
import { getAllActions, getActions } from '../../../extension/action-queue.js';
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
  const dates = await getEventDates();
  const out = [];
  for (const d of dates) {
    for (const e of await getEventsByDate(d)) if (e.type === type) out.push(e);
  }
  return out;
}

describe('C. Round 1 推荐 → Policy → Action → 自动 Greeting，cap 未满继续 Round 2', () => {
  it('三个推荐岗位全部自动打招呼，然后进入第 2 轮', async () => {
    const round1 = [makeJob({ jobId: 'j-1', score: 88 }), makeJob({ jobId: 'j-2', score: 86 }), makeJob({ jobId: 'j-3', score: 84 })];
    const round2 = [makeJob({ jobId: 'j-4', score: 90 }), makeJob({ jobId: 'j-5', score: 82 })];
    const h = makeHarness(
      {
        jobs: round1,
        round2Jobs: round2,
        replanResponses: [
          { ok: true, status: 'complete', reason: '本轮结束', newQueries: [] },
          { ok: true, status: 'continue', reason: '继续补充', newQueries: [{ keyword: '二轮 AI 产品经理' }] },
        ],
      },
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3 },
    );

    const start = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(start.ok).toBe(true);

    const run = await h.runUntil(done);
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
    // 5 个岗位全部成功打招呼（3 + 2），并且达到 cap 后收工
    expect(h.calls.greet).toEqual(['j-1', 'j-2', 'j-3', 'j-4', 'j-5']);
    expect(rt.todayGreetingCount).toBe(5);
    expect(rt.roundIndex).toBe(2); // 第 2 轮跑完就因 cap 收工，不进入第 3 轮

    const actions = await getAllActions();
    expect(actions).toHaveLength(5);
    expect(actions.every((a) => a.status === 'success')).toBe(true);
    expect(actions.every((a) => a.mode === 'autopilot')).toBe(true);

    const sent = await allEventsByType(EVENT_TYPES.GREETING_SENT);
    expect(sent).toHaveLength(5);
    for (const id of ['j-1', 'j-4']) {
      expect((await getJobState(id))?.state).toBe('GREETED');
    }

    const completed = await allEventsByType(EVENT_TYPES.DISCOVERY_ROUND_COMPLETED);
    expect(completed).toHaveLength(2);
    expect(completed[0].metadata).toMatchObject({ roundIndex: 1, recommendedCount: 3 });
    expect(completed[1].metadata).toMatchObject({ roundIndex: 2, recommendedCount: 2 });

    const finished = await allEventsByType(EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE);
    expect(finished).toHaveLength(1);
    expect(finished[0].metadata.code).toBe('DAILY_CAP_REACHED');
  });

  it('Autopilot 创建 Action 时会写 ACTION_CREATED 且 mode=autopilot', async () => {
    const h = makeHarness({ jobs: [makeJob({ jobId: 'j-1', score: 90 })], replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done);
    const created = await allEventsByType(EVENT_TYPES.ACTION_CREATED);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].metadata.mode).toBe('autopilot');
  });
});

describe('D. Daily Cap 硬约束（cap=5, already=3, 推荐 8 → 最多 2 个）', () => {
  it('最多只创建并执行 2 个 Action，其余在创建阶段就被 Policy 拒绝', async () => {
    const jobs = Array.from({ length: 8 }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 90 - i }));
    const h = makeHarness({ jobs, replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] }, { dailyGreetingCap: 5 });
    await h.chromeStub.storage.local.set({ [`greet-${localDateKey()}`]: 3 });

    const start = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(start.ok).toBe(true);
    expect((await loadRuntime()).todayGreetingCount).toBe(3);

    const run = await h.runUntil(done);
    expect(run.reached).toBe(true);

    expect(h.calls.greet).toHaveLength(2);
    const actions = await getAllActions();
    expect(actions).toHaveLength(2); // 不是 6、也不是 8
    expect(actions.every((a) => a.status === 'success')).toBe(true);

    const daily = await allEventsByType(EVENT_TYPES.GREETING_SENT);
    expect(daily).toHaveLength(2);

    // 被 Policy 拒绝的候选留下可审计的 ACTION_SKIPPED（带 reason），但没有 Action 记录
    const skipped = await allEventsByType(EVENT_TYPES.ACTION_SKIPPED);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].metadata).toMatchObject({ source: 'policy', phase: 'create' });
    expect(String(skipped[0].metadata.reason)).toContain('上限');

    const rt = await loadRuntime();
    expect(rt.todayGreetingCount).toBe(5);
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
  });
});

describe('E. Max Rounds（max=3 → 不允许 Round 4）', () => {
  it('跑满 3 轮后收工，并给出 MAX_ROUNDS_REACHED', async () => {
    const round1 = [makeJob({ jobId: 'r1-1', score: 88 })];
    const round2 = [makeJob({ jobId: 'r2-1', score: 88 })];
    const round3 = [makeJob({ jobId: 'r3-1', score: 88 })];
    const h = makeHarness(
      {
        jobs: round1,
        searchRows: (q) =>
          q.keyword.includes('二轮A') ? round2 : q.keyword.includes('二轮B') ? round3 : round1,
        replanResponses: [
          { ok: true, status: 'complete', newQueries: [] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '二轮A' }] },
          { ok: true, status: 'complete', newQueries: [] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '二轮B' }] },
          { ok: true, status: 'complete', newQueries: [] },
        ],
      },
      // 阈值调到 99：Policy 一律拒绝 → 不会真的打招呼，但轮次照常推进
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3, minimumAutoGreetingScore: 99 },
    );

    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    expect(rt.roundIndex).toBe(3);
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);

    const started = await allEventsByType(EVENT_TYPES.DISCOVERY_ROUND_STARTED);
    const completed = await allEventsByType(EVENT_TYPES.DISCOVERY_ROUND_COMPLETED);
    expect(started).toHaveLength(3); // 没有第 4 轮
    expect(completed).toHaveLength(3);

    const finished = await allEventsByType(EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE);
    expect(finished[0].metadata.code).toBe('MAX_ROUNDS_REACHED');
    expect(h.calls.greet).toEqual([]);
  });
});

describe('F. 无新结果 → OUTREACH_COMPLETE', () => {
  it('第 2 轮搜到的都是已见过的岗位 → 直接收工（不会空转）', async () => {
    const jobs = [makeJob({ jobId: 'j-1', score: 88 })];
    const h = makeHarness(
      {
        jobs,
        searchRows: () => jobs, // 第二轮返回同一批
        replanResponses: [
          { ok: true, status: 'complete', newQueries: [] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '二轮同批' }] },
        ],
      },
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3 },
    );

    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done);
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
    const finished = await allEventsByType(EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE);
    expect(finished[0].metadata.code).toBe('NO_NEW_RESULTS');
    expect(h.calls.greet).toEqual(['j-1']); // 只打过一次
  });

  it('无法产生新的搜索词时也直接收工（不会重复搜同一个关键词）', async () => {
    const h = makeHarness(
      {
        jobs: [makeJob({ jobId: 'j-1', score: 88 })],
        replanResponses: [
          { ok: true, status: 'complete', newQueries: [] },
          // 第二轮只想重复第一轮的词 → 被 dedupe 拦掉
          { ok: true, status: 'continue', newQueries: [{ keyword: 'AI产品经理' }] },
        ],
      },
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done);
    const finished = await allEventsByType(EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE);
    expect(finished[0].metadata.code).toBe('NO_NEW_RESULTS');
    expect((await loadRuntime()).roundIndex).toBe(1);
  });
});

describe('G. 跨轮 Dedupe（同一天不重复处理同一个岗位）', () => {
  it('第 1、2 轮都出现 Job A → 只处理一次；新出现的 Job B 正常处理', async () => {
    const a = makeJob({ jobId: 'job-A', score: 88 });
    const b = makeJob({ jobId: 'job-B', score: 90 });
    const h = makeHarness(
      {
        jobs: [a],
        searchRows: (q) => (q.keyword.includes('二轮') ? [a, b] : [a]),
        replanResponses: [
          { ok: true, status: 'complete', newQueries: [] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '二轮补充' }] },
          { ok: true, status: 'complete', newQueries: [] },
        ],
      },
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3 },
    );

    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });

    // 只对 A / B 各打一次招呼
    expect(h.calls.greet.filter((id) => id === 'job-A')).toHaveLength(1);
    expect(h.calls.greet.filter((id) => id === 'job-B')).toHaveLength(1);

    const discovered = await allEventsByType(EVENT_TYPES.JOB_DISCOVERED);
    expect(discovered.filter((e) => e.jobId === 'job-A')).toHaveLength(1);
    expect(discovered.filter((e) => e.jobId === 'job-B')).toHaveLength(1);

    const sent = await allEventsByType(EVENT_TYPES.GREETING_SENT);
    expect(sent.filter((e) => e.jobId === 'job-A')).toHaveLength(1);
    expect(sent.filter((e) => e.jobId === 'job-B')).toHaveLength(1);

    const actions = await getActions({ type: 'GREETING' });
    expect(actions.map((x) => x.jobId).sort()).toEqual(['job-A', 'job-B']);

    const rt = await loadRuntime();
    expect(rt.seenJobIds.filter((id: string) => id === 'job-A')).toHaveLength(1);
  });

  it('已经 GREETED 的岗位不会在后续轮次再次进入 Action Queue', async () => {
    const a = makeJob({ jobId: 'job-A', score: 88 });
    const h = makeHarness(
      {
        jobs: [a],
        searchRows: () => [a],
        replanResponses: [
          { ok: true, status: 'complete', newQueries: [] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '二轮X' }] },
        ],
      },
      { dailyGreetingCap: 5, maxDiscoveryRounds: 3 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });
    expect(h.calls.greet).toEqual(['job-A']);
    expect(await getAllActions()).toHaveLength(1);
  });
});
