import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ModelClient, vcrCall, isLiveMode } from './index';
import { normalizePlan, planJobSearch, plannerSchema } from './job-plan';
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
    cities: [{ name: '杭州' }, { name: '深圳' }],
    targetTitles: ['AI产品经理'],
    preferredSkills: ['Agent', 'LLM'],
    excludeTokens: ['外包', '售前', '纯运营'],
    salaryMinK: 30,
    targetQualifiedJobs: 10,
    dailyGreetingCap: 5,
    keywords: ['AI产品经理', 'Agent产品经理'],
  };

  it('支持城市正确映射 code，初始查询为 city×keyword 组合且 source=initial', () => {
    const { goal, queries, warnings } = normalizePlan(base, 'g');
    expect(warnings).toEqual([]);
    expect(goal.cities).toEqual([
      { name: '杭州', code: SUPPORTED_CITIES['杭州'] },
      { name: '深圳', code: SUPPORTED_CITIES['深圳'] },
    ]);
    expect(queries).toHaveLength(4); // 2 城市 × 2 关键词
    expect(queries.every((q) => q.source === 'initial')).toBe(true);
    expect(new Set(queries.map((q) => `${q.cityCode}::${q.keyword}`)).size).toBe(4);
  });

  it('不支持的城市：给 warning 而不是猜 code', () => {
    const { goal, warnings } = normalizePlan({ ...base, cities: [{ name: '成都' }] }, 'g');
    expect(warnings.join('|')).toContain('成都');
    expect(goal.cities).toEqual([]);
  });

  it('初始查询总数不超过 MAX_INITIAL_QUERIES（模型给再多关键词也一样）', () => {
    const many: PlannerOutput = {
      ...base,
      keywords: ['AI产品经理', 'Agent产品经理', '大模型产品经理', '智能客服产品经理', 'AI平台产品经理', '对话AI产品经理'],
    };
    const { queries } = normalizePlan(many, 'g');
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
        produce: () => planJobSearch(client, ACCEPTANCE_GOAL),
      });
      // 城市
      const names = plan.goal.cities.map((c) => c.name).sort();
      expect(names).toEqual(['杭州', '深圳']);
      expect(plan.goal.cities.every((c) => c.code === (SUPPORTED_CITIES as Record<string, string>)[c.name])).toBe(true);
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
