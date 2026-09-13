// V0.5 Phase 3 修复回归：评分阶段（分批 / 失败可恢复 / 不重复付费）
// 真实事故：/score 成功响应是 {results}（无 ok），早期实现把它当失败 →
// 用户看到 "Autopilot paused：评分失败"，Resume 后又把同一批 15 个岗位重评一遍。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { SCORE_BATCH_SIZE } from '../../../extension/autopilot-engine.js';
import { getEventsByDate, EVENT_TYPES, localDateKey } from '../../../extension/event-store.js';

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

const manyJobs = (n: number) => Array.from({ length: n }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 88 }));

describe('评分分批（避免一次 60 秒的模型调用被 SW 回收）', () => {
  it('12 个岗位 → 分 3 批（5/5/2），每批都要落盘', async () => {
    const h = makeHarness(
      { jobs: manyJobs(12), replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] },
      { dailyGreetingCap: 1, minimumAutoGreetingScore: 99 }, // 阈值调高：不真的打招呼
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    expect(SCORE_BATCH_SIZE).toBe(5);
    expect(h.calls.scoreBatches.map((b) => b.length)).toEqual([5, 5, 2]);
    // 每个岗位只被评一次
    const flat = h.calls.scoreBatches.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toHaveLength(12);
  });

  it('每批评分都写入 JOB_SCORED 事件（持久化审计）', async () => {
    const h = makeHarness({ jobs: manyJobs(7), replanResponses: [{ ok: true, status: 'complete', newQueries: [] }] }, { minimumAutoGreetingScore: 99 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });
    const scored = (await getEventsByDate(localDateKey())).filter((e) => e.type === EVENT_TYPES.JOB_SCORED);
    expect(scored).toHaveLength(7);
  });
});

describe('评分失败可恢复，且不重复付费', () => {
  it('第 2 批失败 → PAUSED，原因里带真实错误与已评/剩余数量', async () => {
    const h = makeHarness(
      {
        jobs: manyJobs(12),
        replanResponses: [{ ok: true, status: 'complete', newQueries: [] }],
        scoreFailAt: [2],
        scoreError: 'upstream model crashed',
      },
      { minimumAutoGreetingScore: 99 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil((rt) => rt.status === AUTOPILOT_STATUS.PAUSED, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.PAUSED);
    expect(rt.pauseReason).toContain('评分失败：upstream model crashed');
    expect(rt.pauseReason).toContain('已评 5 个');
    expect(rt.pauseReason).toContain('剩余 7 个');
    expect(h.calls.scoreBatches.map((b) => b.length)).toEqual([5, 5]);
  });

  it('Resume 后只评剩下的岗位（已评过的不会再花钱）', async () => {
    const h = makeHarness(
      {
        jobs: manyJobs(12),
        replanResponses: [{ ok: true, status: 'complete', newQueries: [] }],
        scoreFailAt: [2],
        scoreError: 'upstream model crashed',
      },
      { minimumAutoGreetingScore: 99 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil((rt) => rt.status === AUTOPILOT_STATUS.PAUSED, { maxSteps: 200 });

    const firstBatch = [...h.calls.scoreBatches[0]];
    const resumed = await h.engine.resumeAutopilot();
    expect(resumed.ok).toBe(true);
    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    const laterBatches = h.calls.scoreBatches.slice(2).flat();
    expect(laterBatches).toHaveLength(7); // 只剩第二批的 5 个 + 第三批的 2 个
    for (const id of firstBatch) {
      expect(laterBatches).not.toContain(id); // 已经评过的岗位不再出现在任何后续请求里
    }
    const allScored = h.calls.scoreBatches.flat();
    expect(new Set(allScored).size).toBe(12);
  });

  it('暂停的恢复路径不会绕过 Policy（阈值未达 → 不创建 Action）', async () => {
    const h = makeHarness(
      { jobs: manyJobs(6), replanResponses: [{ ok: true, status: 'complete', newQueries: [] }], scoreFailAt: [1] },
      { minimumAutoGreetingScore: 99 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil((rt) => rt.status === AUTOPILOT_STATUS.PAUSED, { maxSteps: 100 });
    await h.engine.resumeAutopilot();
    await h.runUntil(done, { maxSteps: 200 });
    expect(h.calls.greet).toEqual([]);
  });
});
