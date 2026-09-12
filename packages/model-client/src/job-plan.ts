import { z } from 'zod';
import type { ModelClient } from './client';
import {
  SUPPORTED_CITIES,
  MAX_INITIAL_QUERIES,
  MAX_REPLAN_QUERIES,
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


// ---------------------------------------------------------------------------
// V0.4 Replan：只允许"新增 keyword"。城市/薪资/排除项/每日上限一律以原 goal 为准，
// 模型即使返回这些字段也会被忽略；结果已达标或超过上限时直接 complete（不调模型）。
// ---------------------------------------------------------------------------

export const replanSchema = z.object({
  status: z.enum(['continue', 'complete']),
  reason: z.string(),
  newKeywords: z.array(z.string()).default([]),
});

export type ReplanOutput = z.infer<typeof replanSchema>;

export interface ReplanResultSummary {
  discoveredCount: number;
  qualifiedCount: number;
  strongMatchCount: number;
  topTitles: string[];
  rejectedReasons: string[];
}

export function buildReplanSystem(goal: JobSearchGoal): string {
  return [
    '你是求职搜索策略评估器。根据"当前结果"判断是否需要补充搜索词，只输出 JSON。',
    '',
    '【严格限制】',
    '- 只能新增搜索 keyword；禁止修改城市、薪资下限、排除项、每日上限',
    '- 判定规则（必须严格遵守）：当「≥75 分数量」< 「目标高匹配岗位数」时，必须返回 status="continue" 并给出 2~4 个新关键词；',
    '- 只有当 ≥75 分数量已达标时，才允许返回 status="complete" 且 newKeywords 为空；',
    '- 新关键词要能带来新岗位（例如岗位名细分方向），不要重复已搜索组合',
    '- 需要补充时，最多 4 个新关键词，优先高召回（例：AI平台产品经理、智能客服产品经理）',
    '- 不允许用"放宽条件"（取消排除项/降低薪资）来凑数量',
    '',
    `当前固定条件（不可修改）：城市=${goal.cities.map((c) => c.name).join('、')}，薪资下限=${goal.salaryMinK ?? '不限'}K，排除项=${goal.excludeTokens.join('、') || '无'}`,
    '输出 JSON：{"status":"continue|complete","reason":"给用户看的一句话说明","newKeywords":[]}',
  ].join('\n');
}

export function buildReplanUser(input: {
  goal: JobSearchGoal;
  searchedQueries: SearchQuery[];
  resultSummary: ReplanResultSummary;
}): string {
  const searched = input.searchedQueries.map((q) => `${q.cityName}·${q.keyword}`).join('；') || '无';
  const rs = input.resultSummary;
  return [
    `目标高匹配岗位数：${input.goal.targetQualifiedJobs}`,
    `已搜索组合：${searched}`,
    `发现岗位：${rs.discoveredCount}`,
    `通过硬过滤：${rs.qualifiedCount}`,
    `≥75 分：${rs.strongMatchCount}`,
    `高频岗位名：${rs.topTitles.join('、') || '无'}`,
    `被排除原因：${rs.rejectedReasons.join('；') || '无'}`,
    '',
    '请输出唯一 JSON。',
  ].join('\n');
}

/** 把新关键词按"城市×关键词"展开成查询，跳过已搜索组合，总数受 MAX_REPLAN_QUERIES 限制 */
export function expandReplanQueries(
  goal: JobSearchGoal,
  searchedQueries: SearchQuery[],
  newKeywords: string[],
): { queries: SearchQuery[]; dropped: Array<{ keyword: string; reason: string }> } {
  const searched = new Set(searchedQueries.map((q) => `${q.cityCode}::${q.keyword.trim().toLowerCase()}`));
  const queries: SearchQuery[] = [];
  const dropped: Array<{ keyword: string; reason: string }> = [];
  const seenKeyword = new Set<string>();
  for (const raw of newKeywords ?? []) {
    const keyword = String(raw ?? '').trim();
    if (!keyword) continue;
    if (seenKeyword.has(keyword.toLowerCase())) {
      dropped.push({ keyword, reason: '重复关键词' });
      continue;
    }
    seenKeyword.add(keyword.toLowerCase());
    let entirelySearched = true;
    for (const city of goal.cities) {
      const key = `${city.code}::${keyword.toLowerCase()}`;
      if (searched.has(key)) continue;
      entirelySearched = false;
      if (queries.length >= MAX_REPLAN_QUERIES) {
        dropped.push({ keyword, reason: `超过单次新增上限 ${MAX_REPLAN_QUERIES}` });
        break;
      }
      searched.add(key);
      queries.push({ cityName: city.name, cityCode: city.code, keyword, source: 'replan' });
    }
    if (entirelySearched) dropped.push({ keyword, reason: '已搜索过' });
  }
  return { queries, dropped };
}

/** 调用模型做一次 Replan（程序先做"是否还允许 Replan"的判断） */
export async function replanJobSearch(
  client: ModelClient,
  input: { goal: JobSearchGoal; searchedQueries: SearchQuery[]; resultSummary: ReplanResultSummary; replanCount: number },
): Promise<{ status: 'continue' | 'complete'; reason: string; newQueries: SearchQuery[] }> {
  const target = input.goal.targetQualifiedJobs ?? DEFAULT_TARGET_QUALIFIED_JOBS;
  // 程序侧护栏：达标 或 已达上限 → 直接结束，不消耗模型调用
  if (input.resultSummary.strongMatchCount >= target) {
    return { status: 'complete', reason: `已有 ${input.resultSummary.strongMatchCount} 个 ≥75 分岗位，达到目标 ${target}。`, newQueries: [] };
  }
  if ((input.replanCount ?? 0) >= 1) {
    return { status: 'complete', reason: '已达到 Replan 上限（最多 1 次），本轮结束。', newQueries: [] };
  }

  const raw = (await client.chatJson(
    replanSchema,
    buildReplanSystem(input.goal),
    buildReplanUser(input),
  )) as ReplanOutput;

  if (raw.status === 'complete') {
    return { status: 'complete', reason: raw.reason || '模型判断无需补充搜索。', newQueries: [] };
  }
  const { queries } = expandReplanQueries(input.goal, input.searchedQueries, raw.newKeywords ?? []);
  if (!queries.length) {
    return { status: 'complete', reason: '没有可用的新搜索组合（可能都已搜索过），本轮结束。', newQueries: [] };
  }
  return { status: 'continue', reason: raw.reason || '补充搜索词以增加覆盖。', newQueries: queries };
}
