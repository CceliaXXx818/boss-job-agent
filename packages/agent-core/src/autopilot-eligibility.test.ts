// V0.5 Phase 3 修复回归：Replan 终止条件 = autopilotEligibleJobs >= batchQualifiedTarget
//
// 真实问题：设置 batchQualifiedTarget=2 / minimumAutoGreetingScore=85，
// 日志却是 "Recommended 2 → 仍然 Replan → 新增 4 个搜索词"。
// 根因：stepEvaluate 用 Planner 的 successCriteria.targetQualifiedJobs（V0.4 默认 10）当目标，
// 且在 Policy/eligibility 之前就决定了 Replan。现在把三个概念拆开：
//   recommendedJobs（AI 推荐 ≥75） / autopilotEligibleJobs（静态可自动联系） / Round Target（settings.batchQualifiedTarget）
import { describe, it, expect, afterEach, vi } from 'vitest';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { getAllActions } from '../../../extension/action-queue.js';
import {
  decideReplanForCandidates,
  filterAutopilotEligible,
  needsReplan,
} from '../../../extension/discovery-runner.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHarness(opts: HarnessOptions = {}, settingsOver: Record<string, unknown> = {}) {
  return createHarness({
    ...opts,
    initialStorage: { jobAgentSettings: autopilotSettings(settingsOver), ...(opts.initialStorage ?? {}) },
  });
}

/** 用户的真实配置：阈值 85 / 每日上限 1 / 候选目标 2 / 最多 2 轮 */
const USER_SETTINGS = { minimumAutoGreetingScore: 85, dailyGreetingCap: 1, batchQualifiedTarget: 2, maxDiscoveryRounds: 2 };

const done = (rt: { status: string }) =>
  rt.status === AUTOPILOT_STATUS.MONITORING || rt.status === AUTOPILOT_STATUS.OUTREACH_COMPLETE;

describe('概念拆分（纯函数）', () => {
  const job = (id: string, score: number) => ({ ...makeJob({ jobId: id, score }), __ai: { ok: true, score } });

  it('filterAutopilotEligible：阈值 / 硬排除 / 已联系 / 信息完整性 / 话术有效性', () => {
    const jobs = [
      job('ok', 85),
      job('low', 84),
      { ...makeJob({ jobId: 'excluded', title: '销售代表', score: 90 }), __ai: { ok: true, score: 90 } },
      job('greeted', 90),
      { jobId: 'nohref', title: 'AI 产品经理', __ai: { ok: true, score: 90 } },
      { jobId: 'noscore', title: 'AI 产品经理', href: '/job_detail/noscore.html' },
    ];
    const { eligible, rejected } = filterAutopilotEligible(jobs, {
      minimumAutoGreetingScore: 85,
      hardExclusions: ['销售'],
      greetedJobIds: ['greeted'],
    });
    expect(eligible.map((j) => j.jobId)).toEqual(['ok']);
    const reasons = Object.fromEntries(rejected.map((r) => [r.jobId, r.reason]));
    expect(reasons.low).toBe('分数 84 < 自动联系阈值 85');
    expect(reasons.excluded).toContain('销售');
    expect(reasons.greeted).toContain('已联系');
    expect(reasons.nohref).toContain('不完整');
    expect(reasons.noscore).toContain('AI 评分');
  });

  it('话术不可用时一个都不 eligible', () => {
    const { eligible, rejected } = filterAutopilotEligible([job('a', 90)], { greetingValid: false });
    expect(eligible).toEqual([]);
    expect(rejected[0].reason).toContain('话术');
  });

  it('decideReplanForCandidates：达目标即 skip Replan；不足才 Replan；用尽则继续 Outreach', () => {
    expect(decideReplanForCandidates({ eligibleCount: 2, targetCandidates: 2 })).toMatchObject({
      skipReplan: true,
      code: 'TARGET_REACHED',
    });
    expect(decideReplanForCandidates({ eligibleCount: 3, targetCandidates: 2 }).skipReplan).toBe(true);
    expect(decideReplanForCandidates({ eligibleCount: 1, targetCandidates: 2, replanCount: 0 })).toMatchObject({
      skipReplan: false,
      code: 'NEED_MORE',
    });
    expect(decideReplanForCandidates({ eligibleCount: 0, targetCandidates: 2, replanCount: 1, maxReplan: 1 })).toMatchObject({
      skipReplan: true,
      code: 'REPLAN_EXHAUSTED',
    });
    // deprecated 包装仍保持布尔语义
    expect(needsReplan({ eligibleCount: 1, targetCandidates: 2, replanCount: 0 })).toBe(true);
    expect(needsReplan({ eligibleCount: 2, targetCandidates: 2, replanCount: 0 })).toBe(false);
  });
});

describe('1. threshold=85, target=2, recommended=2, eligible=2 → 不 Replan', () => {
  it('直接进入 Outreach，不调用任何 Replan', async () => {
    const h = makeHarness(
      {
        jobs: [makeJob({ jobId: 'j-1', score: 88 }), makeJob({ jobId: 'j-2', score: 90 })],
        // 故意让 Planner 给出旧的 target=10：Autopilot 必须忽略它
        replanResponses: [{ ok: true, status: 'continue', reason: '不该被用到', newQueries: [{ keyword: '不该搜索' }] }],
      },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    expect(h.calls.replan).toBe(0); // 关键断言：没有触发 Replan
    expect(h.calls.search).toEqual(['AI产品经理']); // 也没有第二次搜索
    expect(h.activities.some((a) => a.includes('Candidate target reached'))).toBe(true);
    expect(h.activities.filter((a) => a.startsWith('Recommended'))).toContain('Recommended 2');
    expect(h.activities).toContain('Autopilot Eligible 2 / Target 2');

    const rt = await loadRuntime();
    expect(rt.batchQualifiedTarget).toBe(2);
    // 按分数降序（90 分在前），便于 Outreach 优先联系最匹配的岗位
    expect(rt.eligibleJobIds).toEqual(['j-2', 'j-1']);
    expect(rt.currentRoundStats.roundTarget).toBe(2);
    expect(rt.currentRoundStats.eligibleCount).toBe(2);
  });
});

describe('2. recommended=2 但分数 82/80（<85）→ eligible=0 → Replan', () => {
  it('分数不达自动联系阈值时必须补充搜索', async () => {
    const h = makeHarness(
      {
        jobs: [makeJob({ jobId: 'j-1', score: 82 }), makeJob({ jobId: 'j-2', score: 80 })],
        replanResponses: [
          { ok: true, status: 'continue', reason: '候选不足', newQueries: [{ keyword: '二轮 AI 产品经理' }] },
          { ok: true, status: 'complete', newQueries: [] },
        ],
      },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    expect(h.calls.replan).toBeGreaterThanOrEqual(1);
    expect(h.activities).toContain('Recommended 2');
    expect(h.activities).toContain('Autopilot Eligible 0 / Target 2');
    expect(h.activities.some((a) => a.includes('触发 Replan'))).toBe(true);
    expect(h.activities.some((a) => a.includes('分数 82 < 自动联系阈值 85'))).toBe(true);
    expect(await getAllActions()).toEqual([]); // 没有合格的候选 → 不会创建 Action
  });
});

describe('3. recommended=4, eligible=1, target=2 → Replan', () => {
  it('只有 1 个达到 85 分时仍要补充搜索', async () => {
    const h = makeHarness(
      {
        jobs: [
          makeJob({ jobId: 'j-1', score: 90 }),
          makeJob({ jobId: 'j-2', score: 84 }),
          makeJob({ jobId: 'j-3', score: 80 }),
          makeJob({ jobId: 'j-4', score: 76 }),
        ],
        replanResponses: [
          { ok: true, status: 'continue', reason: '候选不足', newQueries: [{ keyword: '二轮补充' }] },
          { ok: true, status: 'complete', newQueries: [] },
        ],
      },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });
    expect(h.activities).toContain('Recommended 4');
    expect(h.activities).toContain('Autopilot Eligible 1 / Target 2');
    expect(h.calls.replan).toBeGreaterThanOrEqual(1);
  });
});

describe('4. recommended=5, eligible=2, target=2 → 不 Replan', () => {
  it('eligible 达到目标就跳过 Replan（哪怕 recommended 更多）', async () => {
    const h = makeHarness(
      {
        jobs: [
          makeJob({ jobId: 'j-1', score: 92 }),
          makeJob({ jobId: 'j-2', score: 86 }),
          makeJob({ jobId: 'j-3', score: 84 }),
          makeJob({ jobId: 'j-4', score: 82 }),
          makeJob({ jobId: 'j-5', score: 80 }),
        ],
      },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });
    expect(h.activities).toContain('Recommended 5');
    expect(h.activities).toContain('Autopilot Eligible 2 / Target 2');
    expect(h.calls.replan).toBe(0);
    expect((await loadRuntime()).roundIndex).toBe(1);
  });
});

describe('5. target=2, eligible=3, dailyCap=1 → 只创建 1 个 Action（额度优先）', () => {
  it('Outreach 受 remainingQuota 控制，多出来的合格候选不会被执行', async () => {
    const h = makeHarness(
      {
        jobs: [
          makeJob({ jobId: 'j-1', score: 95 }),
          makeJob({ jobId: 'j-2', score: 90 }),
          makeJob({ jobId: 'j-3', score: 86 }),
        ],
      },
      { ...USER_SETTINGS, dailyGreetingCap: 1 },
    );
    const start = await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    expect(start.ok).toBe(true);

    const run = await h.runUntil(done, { maxSteps: 200 });
    expect(run.reached).toBe(true);

    expect(h.activities).toContain('Autopilot Eligible 3 / Target 2');
    expect(h.calls.replan).toBe(0); // eligible 3 >= target 2 → 跳过 Replan
    expect(h.calls.greet).toHaveLength(1); // 额度只有 1
    const actions = await getAllActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('success');

    const rt = await loadRuntime();
    expect(rt.todayGreetingCount).toBe(1);
    expect(rt.status).toBe(AUTOPILOT_STATUS.MONITORING);
  });
});

describe('6. UI 的 batchQualifiedTarget=2 确实进入 Runtime，且不存在旧的固定 target=10', () => {
  it('Runtime 记录设置值；Planner 的 successCriteria.targetQualifiedJobs=10 不参与判断', async () => {
    const h = makeHarness(
      {
        jobs: [makeJob({ jobId: 'j-1', score: 88 }), makeJob({ jobId: 'j-2', score: 88 })],
      },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.engine.advanceAutopilot(); // PLAN（harness 的假 Planner 固定返回 targetQualifiedJobs: 10）

    const rt = await loadRuntime();
    expect(rt.batchQualifiedTarget).toBe(2);
    expect(rt.currentPlan.successCriteria.targetQualifiedJobs).toBe(10); // 旧值仍存在于计划里（只作参考）
    expect(rt.currentRoundStats.roundTarget).toBe(2); // 但 Autopilot 的目标是 2

    const status = await h.engine.getStatus();
    expect(status.roundTarget).toBe(2);
    expect(status.dailyGreetingCap).toBe(1);

    await h.runUntil(done, { maxSteps: 200 });
    expect(h.calls.replan).toBe(0);
  });

  it('引擎源码不再用 Planner 的 targetQualifiedJobs 决定 Replan', async () => {
    const engine = await import('node:fs').then((fs) =>
      fs.readFileSync('extension/autopilot-engine.js', 'utf8'),
    );
    expect(engine).not.toMatch(/successCriteria\?\.targetQualifiedJobs\s*\?\?/);
    expect(engine).not.toMatch(/needsReplan\(/);
    expect(engine).toMatch(/decideReplanForCandidates\(/);
    expect(engine).toMatch(/filterAutopilotEligible\(/);
  });
});

describe('Activity Log 可观察性', () => {
  it('按顺序输出 Recommended / Autopilot Eligible / 决策原因', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 90 }), makeJob({ jobId: 'j-2', score: 87 })] },
      USER_SETTINGS,
    );
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    await h.runUntil(done, { maxSteps: 200 });

    const idx = (needle: string) => h.activities.findIndex((a) => a.includes(needle));
    const iRec = idx('Recommended 2');
    const iElig = idx('Autopilot Eligible 2 / Target 2');
    const iDecision = idx('Candidate target reached');
    expect(iRec).toBeGreaterThanOrEqual(0);
    expect(iElig).toBeGreaterThan(iRec);
    expect(iDecision).toBeGreaterThan(iElig);
  });
});
