// V0.5 Phase 3 小修：/replan 的 Autopilot 语义（不再被 V0.4 的硬编码守卫拦掉）
//
// 真实问题：用户设置 batchQualifiedTarget=2 / minimumAutoGreetingScore=85，
// 但 replanJobSearch 里有一条 V0.4 守卫 `strongMatchCount >= goal.targetQualifiedJobs(10)`
// → 12 个 ≥75 分就直接返回 complete（"无需补充"），**根本没调用模型**，
// 于是引擎只好靠"再开一轮"来补搜，日志看起来自相矛盾。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReplanUser, replanJobSearch, useAutopilotTarget } from './job-plan.js';
import type { JobSearchGoal } from './job-plan.js';

const goal: JobSearchGoal = {
  rawGoal: '上海 AI 产品经理',
  cities: [{ name: '上海', code: '101020100' }],
  hardExclusions: [],
  softNegativePreferences: [],
  targetTitles: ['AI 产品经理'],
  preferredSkills: [],
  salaryMinK: 30,
  targetQualifiedJobs: 10,
  dailyGreetingCap: 2,
};

const summary = (over: Record<string, unknown> = {}) => ({
  discoveredCount: 30,
  qualifiedCount: 12,
  strongMatchCount: 12,
  topTitles: ['AI 产品经理'],
  rejectedReasons: [],
  ...over,
});

const fakeClient = (out: unknown = { status: 'continue', reason: 'model', newKeywords: ['智能体产品经理'] }) =>
  ({ chatJson: async () => out }) as never;

describe('useAutopilotTarget', () => {
  it('只有显式给了 targetCandidates 才启用 Autopilot 语义（Review 不传 → 保持 V0.4）', () => {
    expect(useAutopilotTarget(summary())).toBe(false);
    expect(useAutopilotTarget(summary({ targetCandidates: 2, eligibleCount: 0 }))).toBe(true);
    expect(useAutopilotTarget(summary({ targetCandidates: 0 }))).toBe(false);
    expect(useAutopilotTarget(summary({ targetCandidates: 'x' }))).toBe(false);
  });
});

describe('Autopilot 语义下的程序守卫', () => {
  it('eligible 达到候选目标 → complete（不调用模型）', async () => {
    const res = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 0,
      resultSummary: summary({ eligibleCount: 2, targetCandidates: 2, minimumAutoGreetingScore: 85 }),
    });
    expect(res.status).toBe('complete');
    expect(res.newQueries).toEqual([]);
    expect(res.reason).toContain('候选目标 2');
    expect(res.reason).toContain('85');
  });

  it('eligible 不足 → 必须走到模型（旧守卫会在这里错误地返回 complete）', async () => {
    const res = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 0,
      resultSummary: summary({ eligibleCount: 0, targetCandidates: 2, minimumAutoGreetingScore: 85 }),
    });
    expect(res.status).toBe('continue');
    expect(res.newQueries.length).toBeGreaterThan(0);
  });

  it('eligible 不足但 Replan 次数用尽 → complete（不再无限补搜）', async () => {
    const res = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 1,
      resultSummary: summary({ eligibleCount: 0, targetCandidates: 2, minimumAutoGreetingScore: 85 }),
    });
    expect(res.status).toBe('complete');
    expect(res.reason).toContain('Replan 上限');
  });

  it('strongMatchCount=12（≥75）在 Autopilot 语义下不再算达标', async () => {
    const res = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 0,
      resultSummary: summary({ strongMatchCount: 12, eligibleCount: 1, targetCandidates: 2, minimumAutoGreetingScore: 85 }),
    });
    expect(res.status).toBe('continue'); // 1 < 2 → 继续补搜
  });
});

describe('Review（V0.4）行为保持不变', () => {
  it('不传 targetCandidates → 仍按 ≥75 与 targetQualifiedJobs 判定', async () => {
    const enough = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 0,
      resultSummary: summary({ strongMatchCount: 11 }),
    });
    expect(enough.status).toBe('complete');
    expect(enough.reason).toContain('≥75');

    const short = await replanJobSearch(fakeClient(), {
      goal,
      searchedQueries: [],
      replanCount: 0,
      resultSummary: summary({ strongMatchCount: 3 }),
    });
    expect(short.status).toBe('continue');
  });
});

describe('buildReplanUser 的上下文', () => {
  it('Autopilot 模式：给出候选目标 / 阈值 / 当前 eligible / 轮次', () => {
    const text = buildReplanUser({
      goal,
      searchedQueries: [{ cityName: '上海', cityCode: '101020100', keyword: 'AI产品经理', source: 'initial' }],
      resultSummary: summary({
        eligibleCount: 0,
        targetCandidates: 2,
        minimumAutoGreetingScore: 85,
        roundIndex: 1,
        maxRounds: 2,
        rejectedSamples: ['分数 82 < 自动联系阈值 85'],
      }),
    });
    expect(text).toContain('候选目标');
    expect(text).toContain('自动联系阈值');
    expect(text).toContain('85');
    expect(text).toContain('当前可自动联系候选：0');
    expect(text).toContain('第 1 轮 / 最多 2 轮');
    expect(text).toContain('仅供参考');
    expect(text).toContain('分数 82 < 自动联系阈值 85');
  });

  it('Review 模式：仍然是 V0.4 的"目标高匹配岗位数"', () => {
    const text = buildReplanUser({ goal, searchedQueries: [], resultSummary: summary() });
    expect(text).toContain('目标高匹配岗位数：10');
    expect(text).not.toContain('候选目标');
  });
});

describe('源码回归：旧守卫必须退化为 else 分支', () => {
  const src = readFileSync(join(process.cwd(), 'packages', 'model-client', 'src', 'job-plan.ts'), 'utf8');

  it('Autopilot 判定用 eligible，V0.4 判定保留在 else 里', () => {
    expect(src).toMatch(/if \(useAutopilotTarget\(rs\)\) \{/);
    expect(src).toMatch(/eligible >= autopilotTarget/);
    expect(src).toMatch(/\} else \{\s*\n\s*const target = input\.goal\.targetQualifiedJobs/);
  });
});
