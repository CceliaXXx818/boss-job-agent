import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ModelClient, vcrCall, isLiveMode } from './index';
import {
  normalizePlan,
  planJobSearch,
  plannerSchema,
  replanJobSearch,
  expandReplanQueries,
} from './job-plan';
import type { JobSearchGoal } from './job-plan';
import type { PlannerOutput } from './job-plan';
import {
  MAX_INITIAL_QUERIES,
  MAX_REPLAN,
  applyReplanQueries,
  shouldReplan,
  SUPPORTED_CITIES,
} from '../../../extension/core-logic.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PLAN_VCR = join(ROOT, 'fixtures', 'vcr', 'plan.json');
const CTX = { cityName: '上海', cityCode: '101020100' };
const REPLAN_VCR = join(ROOT, 'fixtures', 'vcr', 'replan.json');
const ACCEPTANCE_GOAL = '杭州和深圳AI产品经理，优先Agent和LLM方向，30K以上，不要外包、售前、纯运营';

function hasKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    return /DEEPSEEK_API_KEY\s*=\s*\S+/.test(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return false;
  }
}
const canRun = hasKey() && (isLiveMode() || existsSync(PLAN_VCR));
const maybeIt = canRun ? it : it.skip;
const liveProduce = isLiveMode();

// ---------- 纯函数：Plan 规范化 ----------

describe('V0.4 Planner · normalizePlan（纯函数）', () => {
  const base: PlannerOutput = {
    cities: [{ name: '上海' }], // 与 Browser Context 一致 → 无冲突 warning
    targetTitles: ['AI产品经理'],
    preferredSkills: ['Agent', 'LLM'],
    excludeTokens: ['外包', '售前', '纯运营'],
    salaryMinK: 30,
    targetQualifiedJobs: 10,
    dailyGreetingCap: 5,
    keywords: ['AI产品经理', 'Agent产品经理'],
  };

  it('城市来自 Browser Context；初始查询全部继承当前城市且 source=initial', () => {
    const { goal, queries, warnings } = normalizePlan(base, 'g', CTX);
    expect(warnings).toEqual([]);
    expect(goal.cities).toEqual([{ name: '上海', code: '101020100' }]);
    expect(queries).toHaveLength(2); // 1 城市 × 2 关键词
    expect(queries.every((q) => q.source === 'initial')).toBe(true);
    expect(queries.every((q) => q.cityCode === '101020100' && q.cityName === '上海')).toBe(true);
  });

  it('Goal 提到的城市与当前 BOSS 城市冲突 → warning（不自动切城市）', () => {
    const { goal, warnings, mentionedCities } = normalizePlan(
      { ...base, cities: [{ name: '杭州' }] },
      '杭州AI产品经理',
      CTX,
    );
    expect(mentionedCities).toContain('杭州');
    expect(warnings.join('|')).toContain('当前 BOSS 城市为上海');
    expect(warnings.join('|')).toContain('杭州');
    expect(goal.cities).toEqual([{ name: '上海', code: '101020100' }]); // 城市不变
  });

  it('Goal 未提城市 → 无冲突 warning', () => {
    const { warnings } = normalizePlan({ ...base, cities: [] }, 'AI产品经理', CTX);
    expect(warnings).toEqual([]);
  });

  it('初始查询总数不超过 MAX_INITIAL_QUERIES（模型给再多关键词也一样）', () => {
    const many: PlannerOutput = {
      ...base,
      keywords: ['AI产品经理', 'Agent产品经理', '大模型产品经理', '智能客服产品经理', 'AI平台产品经理', '对话AI产品经理'],
    };
    const { queries } = normalizePlan(many, 'g', CTX);
    expect(queries.length).toBeLessThanOrEqual(MAX_INITIAL_QUERIES);
  });

  it('schema：缺少 keywords 或非法 dailyGreetingCap 会被拒绝', () => {
    expect(plannerSchema.safeParse({ ...base, keywords: [] }).success).toBe(false);
    expect(plannerSchema.safeParse({ ...base, dailyGreetingCap: 99 }).success).toBe(false);
  });
});

// ---------- 纯函数：Evaluator / Replan 护栏（对应验收测试 3~7） ----------

describe('V0.4 Replan 护栏（纯函数，MAX_REPLAN=1）', () => {
  it('结果足够时不需要 Replan', () => {
    expect(shouldReplan({ qualifiedCount: 12, targetQualifiedJobs: 10, replanCount: 0 })).toBe(false);
  });

  it('结果不足且未 Replan 过 → 需要一次 Replan', () => {
    expect(shouldReplan({ qualifiedCount: 6, targetQualifiedJobs: 10, replanCount: 0 })).toBe(true);
  });

  it('已经 Replan 过（MAX_REPLAN=1）→ 不再 Replan', () => {
    expect(shouldReplan({ qualifiedCount: 6, targetQualifiedJobs: 10, replanCount: MAX_REPLAN })).toBe(false);
  });

  it('Replan 只新增 keyword：不重复已搜索组合、单次≤4、城市与硬约束不变', () => {
    const existing = [
      { cityName: '杭州', cityCode: '101210100', keyword: 'AI产品经理', source: 'initial' },
      { cityName: '深圳', cityCode: '101280600', keyword: 'AI产品经理', source: 'initial' },
    ];
    const { queries, dropped } = applyReplanQueries({
      existingQueries: existing,
      newKeywords: ['AI产品经理', 'AI平台产品经理', '智能客服产品经理', '对话AI产品经理', '大模型产品经理', 'Agent产品经理'],
      cityCode: '101210100',
      cityName: '杭州',
    });
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(queries.every((q) => q.source === 'replan')).toBe(true);
    expect(queries.every((q) => q.cityCode === '101210100' && q.cityName === '杭州')).toBe(true);
    expect(queries.some((q) => q.keyword === 'AI产品经理')).toBe(false); // 已搜过
    expect(dropped.some((d) => d.reason === '已搜索过')).toBe(true);
    // 硬约束不在函数的输入范围内——Replan 在结构上无法修改城市/薪资/排除项
    expect(Object.keys(queries[0])).toEqual(['cityName', 'cityCode', 'keyword', 'source']);
  });
});

// ---------- 真模型：Goal → Plan（验收语句） ----------

describe('V0.4 Planner · 真模型解析自然语言目标', () => {
  maybeIt(
    '“杭州和深圳AI产品经理，优先Agent和LLM，30K以上，不要外包/售前/纯运营” 解析正确',
    async () => {
      const client = new ModelClient();
      const plan = await vcrCall({
        file: PLAN_VCR,
        id: 'plan-acceptance',
        live: liveProduce,
        produce: () => planJobSearch(client, ACCEPTANCE_GOAL, CTX),
      });
      // 城市：来自 Browser Context（当前页面），不由 Planner 决定
      expect(plan.goal.cities).toEqual([{ name: '上海', code: '101020100' }]);
      expect(plan.queries.every((q) => q.cityCode === '101020100')).toBe(true);
      // 薪资与排除项（硬约束原样提取，不能被放宽）
      expect(plan.goal.salaryMinK).toBe(30);
      const ex = plan.goal.excludeTokens.join('|');
      expect(ex).toContain('外包');
      expect(ex).toContain('售前');
      expect(ex).toMatch(/运营/);
      // 查询数量受限 + 全部初始
      expect(plan.queries.length).toBeGreaterThan(0);
      expect(plan.queries.length).toBeLessThanOrEqual(MAX_INITIAL_QUERIES);
      expect(plan.queries.every((q) => q.source === 'initial')).toBe(true);
      // successCriteria 默认值
      expect(plan.successCriteria.qualifiedScoreThreshold).toBe(75);
      expect(plan.successCriteria.targetQualifiedJobs).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );
});


// ---------- Phase 4：Replan（程序护栏 + 真模型） ----------

const GOAL: JobSearchGoal = {
  rawGoal: ACCEPTANCE_GOAL,
  cities: [
    { name: '杭州', code: '101210100' },
    { name: '深圳', code: '101280600' },
  ],
  targetTitles: ['AI产品经理', 'Agent产品经理'],
  preferredSkills: ['Agent', 'LLM'],
  excludeTokens: ['外包', '售前', '纯运营'],
  salaryMinK: 30,
  targetQualifiedJobs: 10,
  dailyGreetingCap: 5,
};

const SEARCHED = [
  { cityName: '杭州', cityCode: '101210100', keyword: 'AI产品经理', source: 'initial' as const },
  { cityName: '深圳', cityCode: '101280600', keyword: 'AI产品经理', source: 'initial' as const },
  { cityName: '杭州', cityCode: '101210100', keyword: 'Agent产品经理', source: 'initial' as const },
];

describe('V0.4 Replan · 程序护栏（不依赖模型）', () => {
  const neverCalled = { chatJson: () => { throw new Error('不应调用模型'); } } as never;

  it('结果已达标 → 直接 complete，且不调用模型', async () => {
    const r = await replanJobSearch(neverCalled, {
      goal: GOAL,
      searchedQueries: SEARCHED,
      resultSummary: { discoveredCount: 50, qualifiedCount: 20, strongMatchCount: 12, topTitles: [], rejectedReasons: [] },
      replanCount: 0,
    });
    expect(r.status).toBe('complete');
    expect(r.newQueries).toEqual([]);
  });

  it('已达 MAX_REPLAN=1 → 直接 complete（禁止第三轮）', async () => {
    const r = await replanJobSearch(neverCalled, {
      goal: GOAL,
      searchedQueries: SEARCHED,
      resultSummary: { discoveredCount: 30, qualifiedCount: 8, strongMatchCount: 4, topTitles: [], rejectedReasons: [] },
      replanCount: 1,
    });
    expect(r.status).toBe('complete');
    expect(r.newQueries).toEqual([]);
  });

  it('新查询只新增 keyword：不重复已搜索组合、单次≤4、城市与硬约束不变', () => {
    const { queries, dropped } = expandReplanQueries(GOAL, SEARCHED, [
      'AI产品经理',
      'AI平台产品经理',
      '智能客服产品经理',
      '对话AI产品经理',
      '大模型产品经理',
      'AI解决方案产品经理',
    ]);
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.source === 'replan')).toBe(true);
    expect(queries.every((q) => GOAL.cities.some((c) => c.code === q.cityCode))).toBe(true);
    expect(queries.some((q) => q.keyword === 'AI产品经理' && q.cityCode === '101210100')).toBe(false);
    expect(dropped.some((d) => d.reason.includes('已搜索过') || d.reason.includes('上限'))).toBe(true);
  });

  it('Replan 无法修改硬约束：返回结构里没有薪资/排除项/上限字段', () => {
    const { queries } = expandReplanQueries(GOAL, SEARCHED, ['AI平台产品经理']);
    for (const q of queries) {
      expect(Object.keys(q).sort()).toEqual(['cityCode', 'cityName', 'keyword', 'source']);
    }
    expect(GOAL.salaryMinK).toBe(30);
    expect(GOAL.excludeTokens).toContain('外包');
  });
});

describe('V0.4 Replan · 真模型（结果不足 → 补充搜索词）', () => {
  maybeIt('结果不足时模型只新增 keyword，且不超过上限', async () => {
    const client = new ModelClient();
    const r = await vcrCall({
      file: REPLAN_VCR,
      id: 'replan-insufficient',
      live: liveProduce,
      produce: () =>
        replanJobSearch(client, {
          goal: GOAL,
          searchedQueries: SEARCHED,
          resultSummary: {
            discoveredCount: 42,
            qualifiedCount: 11,
            strongMatchCount: 4,
            topTitles: ['AI产品经理', 'Agent产品经理', '智能客服产品经理'],
            rejectedReasons: ['命中排除词「外包」移除 6 个'],
          },
          replanCount: 0,
        }),
    });
    expect(r.status).toBe('continue'); // 结果不足（4 < 10）必须继续补充搜索
    expect(r.newQueries.length).toBeGreaterThan(0);
    expect(r.newQueries.length).toBeLessThanOrEqual(4);
    for (const q of r.newQueries) {
      expect(q.source).toBe('replan');
      expect(GOAL.cities.some((c) => c.code === q.cityCode)).toBe(true);
    }
  }, 120_000);
});
