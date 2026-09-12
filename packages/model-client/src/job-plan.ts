import { z } from 'zod';
import type { ModelClient } from './client';
import {
  SUPPORTED_CITIES,
  MAX_INITIAL_QUERIES,
  DEFAULT_TARGET_QUALIFIED_JOBS,
  DEFAULT_QUALIFIED_SCORE_THRESHOLD,
} from '../../../extension/core-logic.js';

/**
 * V0.4 Planner：自然语言 Goal → 结构化 Plan。
 * 纪律：LLM 只负责"理解 + 生成搜索词/关键词"，城市必须落在支持列表内，
 * 用户硬约束（薪资/排除项/上限）只允许被原样提取，不允许被模型改写或放宽。
 */

export interface CityRef {
  name: string;
  code: string;
}

export interface JobSearchGoal {
  rawGoal: string;
  cities: CityRef[];
  targetTitles: string[];
  preferredSkills: string[];
  excludeTokens: string[];
  salaryMinK: number | null;
  targetQualifiedJobs: number;
  dailyGreetingCap: number;
}

export interface SearchQuery {
  cityName: string;
  cityCode: string;
  keyword: string;
  source: 'initial' | 'replan';
}

export interface AgentPlan {
  goal: JobSearchGoal;
  queries: SearchQuery[];
  successCriteria: { targetQualifiedJobs: number; qualifiedScoreThreshold: number };
}

export const plannerSchema = z.object({
  cities: z.array(z.object({ name: z.string() })).min(1),
  targetTitles: z.array(z.string()).default([]),
  preferredSkills: z.array(z.string()).default([]),
  excludeTokens: z.array(z.string()).default([]),
  salaryMinK: z.number().int().positive().nullable().default(null),
  targetQualifiedJobs: z.number().int().min(1).max(50).default(DEFAULT_TARGET_QUALIFIED_JOBS),
  dailyGreetingCap: z.number().int().min(1).max(10).default(5),
  keywords: z.array(z.string()).min(1),
});

export type PlannerOutput = z.infer<typeof plannerSchema>;

export function buildPlannerSystem(): string {
  const supported = Object.entries(SUPPORTED_CITIES)
    .map(([name, code]) => `${name}=${code}`)
    .join('、');
  return [
    '你是求职搜索规划器。从用户的一句话目标中提取结构化搜索计划，只输出 JSON。',
    '',
    '【必须提取】',
    '- cities：用户提到的求职城市（只写名称）',
    '- targetTitles：目标岗位名称（如 AI产品经理 / Agent产品经理）',
    '- preferredSkills：偏好技能或方向（如 Agent、LLM、RAG）',
    '- excludeTokens：用户明确不要的（原样保留，如 外包、售前、纯运营）',
    '- salaryMinK：薪资下限，单位 K；没说就 null（例：30K以上 → 30）',
    '- targetQualifiedJobs：用户要求的高匹配岗位数量，没说就 10',
    '- dailyGreetingCap：用户提到的每日上限，没说就 5',
    '- keywords：搜索关键词，3~6 个，优先高召回（例：AI产品经理、Agent产品经理、大模型产品经理）',
    '',
    '【硬性规则】',
    `- 目前只支持这些城市：${supported}；若用户提到其他城市，仍写入 name，但不要编造 code`,
    '- 禁止修改、放宽或删除用户给出的硬约束（薪资/排除项/上限）',
    '- 不要生成大量长尾关键词；keywords 最多 6 个',
    '- 只输出 JSON，结构：{"cities":[{"name":""}],"targetTitles":[],"preferredSkills":[],"excludeTokens":[],"salaryMinK":null,"targetQualifiedJobs":10,"dailyGreetingCap":5,"keywords":[]}',
  ].join('\n');
}

export function buildPlannerUser(rawGoal: string): string {
  return `用户目标：${rawGoal}\n请输出唯一 JSON。`;
}

/** 纯函数：把 Planner 输出规范化为 Plan（城市校验、关键词截断、查询组合生成） */
export function normalizePlan(
  raw: PlannerOutput,
  rawGoal: string,
): { goal: JobSearchGoal; queries: SearchQuery[]; warnings: string[] } {
  const warnings: string[] = [];
  const cities: CityRef[] = [];
  for (const c of raw.cities ?? []) {
    const name = String(c?.name ?? '').trim();
    if (!name) continue;
    const code = (SUPPORTED_CITIES as Record<string, string>)[name];
    if (!code) {
      warnings.push(`暂不支持的城市：${name}（已跳过，未猜测 city code）`);
      continue;
    }
    if (!cities.some((x) => x.code === code)) cities.push({ name, code });
  }
  if (cities.length === 0) warnings.push('没有可用的支持城市，搜索计划为空。');

  const keywords: string[] = [];
  for (const k of raw.keywords ?? []) {
    const v = String(k ?? '').trim();
    if (v && !keywords.includes(v)) keywords.push(v);
  }

  const goal: JobSearchGoal = {
    rawGoal,
    cities,
    targetTitles: raw.targetTitles ?? [],
    preferredSkills: raw.preferredSkills ?? [],
    excludeTokens: raw.excludeTokens ?? [],
    salaryMinK: raw.salaryMinK ?? null,
    targetQualifiedJobs: raw.targetQualifiedJobs ?? DEFAULT_TARGET_QUALIFIED_JOBS,
    dailyGreetingCap: raw.dailyGreetingCap ?? 5,
  };

  // 初始查询：按关键词外层、城市内层展开，总数限制在 MAX_INITIAL_QUERIES
  const queries: SearchQuery[] = [];
  for (const keyword of keywords) {
    for (const city of cities) {
      if (queries.length >= MAX_INITIAL_QUERIES) break;
      queries.push({ cityName: city.name, cityCode: city.code, keyword, source: 'initial' });
    }
    if (queries.length >= MAX_INITIAL_QUERIES) break;
  }

  return { goal, queries, warnings };
}

/** 调用模型生成 Plan（唯一入口） */
export async function planJobSearch(
  client: ModelClient,
  rawGoal: string,
): Promise<{ goal: JobSearchGoal; queries: SearchQuery[]; warnings: string[]; successCriteria: AgentPlan['successCriteria'] }> {
  const raw = (await client.chatJson(plannerSchema, buildPlannerSystem(), buildPlannerUser(rawGoal))) as PlannerOutput;
  const { goal, queries, warnings } = normalizePlan(raw, rawGoal);
  return {
    goal,
    queries,
    warnings,
    successCriteria: {
      targetQualifiedJobs: goal.targetQualifiedJobs,
      qualifiedScoreThreshold: DEFAULT_QUALIFIED_SCORE_THRESHOLD,
    },
  };
}
