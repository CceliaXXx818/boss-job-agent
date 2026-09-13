// V0.5 Phase 3 小修回归：提前收敛 / 详情预算随目标缩放 / Replan 上下文与守卫
//
// 问题背景（用户真实日志）：
//   Round 1：Recommended 12｜Eligible 0 / Target 2｜Replan → "Replan：无需补充" → 却又开了 Round 2
//   ① 服务端 replanJobSearch 里有一条 V0.4 硬编码守卫：strongMatchCount(12) >= targetQualifiedJobs(10)
//      → 直接返回 complete，根本没问模型（也不看用户的候选目标 2 与阈值 85）。
//   ② 引擎一轮固定抓 15 个详情、评完 3 批才判定，导致 target=2 也要花 8 分钟。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { DETAIL_FETCH_LIMIT } from '../../../extension/core-logic.js';
import { buildResultSummary, detailBudgetForTarget } from '../../../extension/discovery-runner.js';
import { useAutopilotTarget } from '@job-agent/model-client';

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

describe('详情预算随候选目标缩放（不再固定 15）', () => {
  it('detailBudgetForTarget：目标 2 → 6；目标 10 → 15（封顶）；下限 5', () => {
    expect(detailBudgetForTarget(2)).toBe(6);
    expect(detailBudgetForTarget(1)).toBe(5);
    expect(detailBudgetForTarget(5)).toBe(15);
    expect(detailBudgetForTarget(10)).toBe(DETAIL_FETCH_LIMIT);
    expect(detailBudgetForTarget(99)).toBe(DETAIL_FETCH_LIMIT);
    expect(detailBudgetForTarget(0)).toBe(5);
  });

  it('目标 2 时最多只抓 6 个详情（哪怕有 30 个合格岗位）', async () => {
    const jobs = Array.from({ length: 30 }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 70 })); // 分数不到阈值 → 不会提前收敛
    const h = makeHarness({ jobs }, { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 1 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 300 });
    expect(run.reached).toBe(true);
    expect(h.calls.detail).toHaveLength(6); // 不是 15
    // 详情预算写进了可读日志（目标 2 → 预算 6）
    expect(h.activities.some((a) => a.includes('详情预算 6'))).toBe(true);
    // 轮次结束时 runtime 会清空本轮缓冲，因此这里看的是本轮"抓过哪些详情"
    expect(new Set(h.calls.detail).size).toBe(6);
  });
});

describe('提前收敛：凑齐候选目标就停止抓详情 / 评分', () => {
  it('前 5 个详情里已有 2 个 ≥85 → 只抓 5 个、只评 1 批', async () => {
    const jobs = [
      makeJob({ jobId: 'good-1', score: 90 }),
      makeJob({ jobId: 'good-2', score: 88 }),
      ...Array.from({ length: 10 }, (_v, i) => makeJob({ jobId: `low-${i + 1}`, score: 78 })),
    ];
    const h = makeHarness(
      { jobs },
      { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 1 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 300 });
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    expect(rt.detailsStoppedEarly).toBe(true);
    expect(h.calls.detail).toHaveLength(5); // 只抓了一批就收手
    expect(h.calls.scoreBatches).toEqual([[expect.stringMatching(/good-1|good-2/), expect.any(String), expect.any(String), expect.any(String), expect.any(String)]]);
    expect(h.calls.score).toBe(1); // 只评一批
    expect(rt.eligibleJobIds.sort()).toEqual(['good-1', 'good-2']);
    expect(h.activities.some((a) => a.includes('已凑齐候选目标') && a.includes('提前结束'))).toBe(true);
    expect(h.calls.replan).toBe(0);
  });

  it('候选不足时不会提前收敛，会继续抓完预算内的详情', async () => {
    const jobs = Array.from({ length: 12 }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 78 })); // 全部 <85
    const h = makeHarness({ jobs }, { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 1 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 300 });
    const rt = await loadRuntime();
    expect(rt.detailsStoppedEarly).toBe(false);
    expect(h.calls.detail).toHaveLength(6); // 预算内抓满
    expect(h.calls.score).toBe(2); // 6 个 → 2 批（5+1）
    expect(rt.eligibleJobIds).toEqual([]);
  });

  it('提前收敛后仍然受 dailyGreetingCap 限制', async () => {
    const jobs = [
      makeJob({ jobId: 'e-1', score: 95 }),
      makeJob({ jobId: 'e-2', score: 90 }),
      makeJob({ jobId: 'e-3', score: 86 }),
      ...Array.from({ length: 6 }, (_v, i) => makeJob({ jobId: `low-${i + 1}`, score: 70 })),
    ];
    const h = makeHarness({ jobs }, { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 2 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 300 });
    expect(run.reached).toBe(true);
    expect(h.calls.greet).toHaveLength(2); // cap=2
    expect((await loadRuntime()).todayGreetingCount).toBe(2);
  });
});

describe('Replan 上下文：告诉模型 eligible / target，而不是 V0.4 的 ≥75 目标', () => {
  it('buildResultSummary 只在给出 targetCandidates 时带上 Autopilot 字段（Review 不受影响）', () => {
    const review = buildResultSummary({ discoveredCount: 10, qualifiedCount: 8, strongMatchCount: 5 });
    expect(review.targetCandidates).toBeUndefined();
    expect(review.eligibleCount).toBeUndefined();

    const autopilot = buildResultSummary({
      discoveredCount: 30,
      qualifiedCount: 12,
      strongMatchCount: 12,
      eligibleCount: 0,
      targetCandidates: 2,
      minimumAutoGreetingScore: 85,
      roundIndex: 1,
      maxRounds: 2,
      rejectedSamples: ['分数 82 < 自动联系阈值 85'],
    });
    expect(autopilot).toMatchObject({
      eligibleCount: 0,
      targetCandidates: 2,
      minimumAutoGreetingScore: 85,
      roundIndex: 1,
      maxRounds: 2,
    });
    expect(useAutopilotTarget(autopilot)).toBe(true);
    expect(useAutopilotTarget(review)).toBe(false);
  });

  it('引擎发给 /replan 的 resultSummary 带eligible/target/阈值（不再让模型看 ≥75 的旧口径）', async () => {
    let captured: Record<string, unknown> | null = null;
    const h = makeHarness(
      {
        jobs: Array.from({ length: 8 }, (_v, i) => makeJob({ jobId: `j-${i + 1}`, score: 78 })), // eligible 恒为 0
        replanResponses: [{ ok: true, status: 'complete', newQueries: [] }],
      },
      { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 1, maxDiscoveryRounds: 1 },
    );
    const originalReplan = h.ai.replanSearch.bind(h.ai);
    h.ai.replanSearch = async (input: { resultSummary: Record<string, unknown> }) => {
      captured = input.resultSummary;
      return originalReplan(input);
    };

    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 300 });

    expect(captured).toBeTruthy();
    expect(captured).toMatchObject({
      eligibleCount: 0,
      targetCandidates: 2,
      minimumAutoGreetingScore: 85,
      roundIndex: 1,
      maxRounds: 1,
    });
    expect((captured as unknown as { rejectedSamples?: string[] }).rejectedSamples?.[0]).toContain('85');
  });

});

describe('日志可观察性（Eligible 不足时要能看到原因）', () => {
  it('Dashboard 日志包含 Eligible/Target 与拒绝原因示例', async () => {
    const jobs = [makeJob({ jobId: 'j-1', score: 82 }), makeJob({ jobId: 'j-2', score: 80 })];
    const h = makeHarness({ jobs }, { batchQualifiedTarget: 2, minimumAutoGreetingScore: 85, dailyGreetingCap: 1, maxDiscoveryRounds: 1 });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 300 });

    const rt = await loadRuntime();
    const line = rt.log.map((l: { text: string }) => l.text).find((t: string) => t.includes('Eligible 0 / Target 2'));
    expect(line).toBeTruthy();
    expect(line).toContain('Replan');
    expect(line).toContain('原因：');
    expect(line).toContain('85');
    expect(rt.eligibleRejectSamples.length).toBeGreaterThan(0);
  });
});

describe('端到端复现用户场景（修复前 vs 修复后）', () => {
  // 用户配置：阈值 85 / 候选目标 2 / 每日上限 2 / 最多 2 轮
  // 用户日志：Round 1 搜 5 个词 → 15 个详情 → Recommended 12 / Eligible 0 → Replan「无需补充」→ 又开 Round 2
  const USER = { minimumAutoGreetingScore: 85, batchQualifiedTarget: 2, dailyGreetingCap: 2, maxDiscoveryRounds: 2 };

  it('Round 1 内就能靠一次正确的 Replan 补搜，而不是白跑一轮', async () => {
    const weak = Array.from({ length: 20 }, (_v, i) => makeJob({ jobId: `weak-${i + 1}`, score: 78 }));
    const strong = [makeJob({ jobId: 'strong-1', score: 92 }), makeJob({ jobId: 'strong-2', score: 88 })];

    const h = makeHarness(
      {
        jobs: weak,
        // 只有补搜出来的新词能搜到 ≥85 的岗位（模拟用户 Round 2 的经验）
        searchRows: (q) => (q.keyword.includes('大模型') ? strong : weak),
        // 模拟"修复后的服务端"：eligible 不足 → 返回新搜索词（而不是用 V0.4 的 ≥75/10 直接 complete）
        replanResponses: [
          { ok: true, status: 'continue', reason: '可自动联系候选不足，补充搜索', newQueries: [{ keyword: '大模型应用产品经理' }] },
        ],
      },
      USER,
    );

    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 300 });
    expect(run.reached).toBe(true);

    const rt = await loadRuntime();
    // 关键改进 1：详情预算按目标缩放（2 → 6），不再固定抓 15 个
    expect(h.calls.detail.length).toBeLessThanOrEqual(6 + 6);
    // 关键改进 2：只用了 1 次 Replan，而且是在 Round 1 内完成的补搜
    expect(h.calls.replan).toBe(1);
    expect(rt.roundIndex).toBe(1); // 没有被迫再开一轮
    // 补搜后达标 → 直接 Outreach，且受 cap 限制
    expect(rt.eligibleJobIds.sort()).toEqual(['strong-1', 'strong-2']);
    expect(h.calls.greet).toHaveLength(2);
    expect(rt.todayGreetingCount).toBe(2);
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);

    // 日志顺序可读：不足 → Replan → 达标 → skip Replan
    const texts = rt.log.map((l: { text: string }) => l.text);
    expect(texts.some((t: string) => t.includes('Eligible 0 / Target 2') && t.includes('Replan'))).toBe(true);
    expect(texts.some((t: string) => t.includes('Eligible 2 / Target 2') && t.includes('skip Replan'))).toBe(true);
  });

  it('每轮只补搜一次（maxReplanPerRound=1 仍然生效）', async () => {
    const weak = Array.from({ length: 20 }, (_v, i) => makeJob({ jobId: `weak-${i + 1}`, score: 78 }));
    const h = makeHarness(
      {
        jobs: weak,
        replanResponses: [
          { ok: true, status: 'continue', newQueries: [{ keyword: '补充词一' }] },
          { ok: true, status: 'continue', newQueries: [{ keyword: '补充词二' }] }, // 不该被用到
        ],
      },
      { ...USER, maxDiscoveryRounds: 1 },
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 300 });
    expect(h.calls.replan).toBe(1);
    expect(h.calls.search).toEqual(['AI产品经理', '补充词一']);
  });
});
