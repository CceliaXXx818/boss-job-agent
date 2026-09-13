import { z } from 'zod';
import type { ModelClient } from './client';
import {
  MAX_INITIAL_QUERIES,
  MAX_REPLAN_QUERIES,
  DEFAULT_TARGET_QUALIFIED_JOBS,
  DEFAULT_QUALIFIED_SCORE_THRESHOLD,
} from '../../../extension/core-logic.js';

/**
 * V0.4.1 Planner / Replan
 * - 城市来自 Browser Context（当前 BOSS 页面），Planner 不再输出 cityCode
 * - 负向约束拆两层：hardExclusions（用户明确否定）/ softNegativePreferences（弱偏好或合理推断）
 * - 程序只允许：新增搜索词、调整排序；绝不放宽用户明确限制
 */

export interface CityRef {
  name: string;
  code: string;
}

export interface BrowserContext {
  cityName: string;
  cityCode: string;
}

export interface JobSearchGoal {
  rawGoal: string;
  cities: CityRef[];
  targetTitles: string[];
  preferredSkills: string[];
  hardExclusions: string[];
  softNegativePreferences: string[];
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
  mentionedCities: z.array(z.string()).default([]),
  targetTitles: z.array(z.string()).default([]),
  preferredSkills: z.array(z.string()).default([]),
  salaryMinK: z.number().int().positive().nullable().default(null),
  hardExclusions: z.array(z.string()).default([]),
  softNegativePreferences: z.array(z.string()).default([]),
  targetQualifiedJobs: z.number().int().min(1).max(50).default(DEFAULT_TARGET_QUALIFIED_JOBS),
  dailyGreetingCap: z.number().int().min(1).max(10).default(5),
  keywords: z.array(z.string()).min(1),
});

export type PlannerOutput = z.infer<typeof plannerSchema>;

export function buildPlannerSystem(): string {
  return [
    '你是求职搜索规划器。从用户的一句话目标中提取结构化搜索计划，只输出 JSON。',
    '',
    '【输出字段】',
    '- mentionedCities：用户在目标中明确提到的城市名（如 ["杭州"]）；没提到就 []。不要输出任何 cityCode。',
    '- targetTitles：目标岗位名称（如 AI产品经理 / Agent产品经理）',
    '- preferredSkills：偏好技能或方向（如 Agent、LLM、平台型产品）',
    '- salaryMinK：薪资下限，单位 K；没说就 null（例：30K以上 → 30）',
    '- hardExclusions：**硬排除**，只允许来自用户明确否定',
    '- softNegativePreferences：**弱负向偏好**，来自用户弱否定或对整体目标的合理推断',
    '- targetQualifiedJobs：用户要求的高匹配岗位数量，没说就 10',
    '- dailyGreetingCap：用户提到的每日上限，没说就 5',
    '- keywords：搜索关键词，3~6 个，优先高召回（例：AI产品经理、Agent产品经理、大模型产品经理）',
    '',
    '【hardExclusions 规则（强约束）】',
    '- 只有出现明确否定语义才可写入：不要 / 不接受 / 不考虑 / 拒绝 / 必须排除 / 不做 / 不能接受',
    '- 例：“不要外包，不接受长期出差，不考虑销售” → ["外包","长期出差","销售"]',
    '- 禁止把模型自己推测的内容升级为 hardExclusions',
    '',
    '【softNegativePreferences 规则（弱约束）】',
    '- 出现弱否定或偏好性表述时写入：不太想 / 最好不要 / 别太偏 / 不是很喜欢 / 希望少一些 / 优先避免',
    '- 也可以对整体目标做合理推断（例如"想做核心 AI 产品，偏 Agent 平台"→ ["纯实施","交付属性过强"]）',
    '- 但这类内容**绝不允许**写进 hardExclusions',
    '- 反例：“可以接受少量售前沟通” → 不能识别为负向偏好，soft 与 hard 都为空',
    '',
    '【城市】',
    '- 城市由浏览器上下文决定；你只负责把用户提到的城市名放进 mentionedCities，用于冲突提示',
    '',
    '【输出格式（严格 JSON，不要解释）】',
    '{"mentionedCities":[],"targetTitles":[],"preferredSkills":[],"salaryMinK":null,"hardExclusions":[],"softNegativePreferences":[],"targetQualifiedJobs":10,"dailyGreetingCap":5,"keywords":[]}',
  ].join('\n');
}

export function buildPlannerUser(rawGoal: string): string {
  return `用户目标：${rawGoal}\n请输出唯一 JSON。`;
}

// ---------------------------------------------------------------------------
// Plan 规范化（纯函数）
// ---------------------------------------------------------------------------

export function normalizePlan(
  raw: PlannerOutput,
  rawGoal: string,
  context: BrowserContext,
): {
  goal: JobSearchGoal;
  queries: SearchQuery[];
  warnings: string[];
  mentionedCities: string[];
  conflict: { conflict: boolean; others: string[] };
} {
  const warnings: string[] = [];
  const mentionedCities = (raw.mentionedCities ?? [])
    .map((c) => String(c ?? '').trim().replace(/市$/, ''))
    .filter(Boolean);
  const contextCity = String(context.cityName ?? '').trim().replace(/市$/, '');
  const others = mentionedCities.filter((c) => c && c !== contextCity);
  if (others.length) {
    warnings.push(
      `当前 BOSS 城市为${contextCity}，但你的求职目标中提到了${others.join('、')}。请先将 BOSS 切换到${others[0]}后重新开始。`,
    );
  }

  const keywords: string[] = [];
  for (const k of raw.keywords ?? []) {
    const v = String(k ?? '').trim();
    if (v && !keywords.includes(v)) keywords.push(v);
  }

  // 防御：soft 绝不能出现在 hard 中（即使模型违反，程序也拆开）
  const hard = uniqStrings(raw.hardExclusions ?? []);
  const soft = uniqStrings(raw.softNegativePreferences ?? []).filter((t) => !hard.includes(t));

  const goal: JobSearchGoal = {
    rawGoal,
    cities: [{ name: contextCity, code: context.cityCode }],
    targetTitles: raw.targetTitles ?? [],
    preferredSkills: raw.preferredSkills ?? [],
    hardExclusions: hard,
    softNegativePreferences: soft,
    salaryMinK: raw.salaryMinK ?? null,
    targetQualifiedJobs: raw.targetQualifiedJobs ?? DEFAULT_TARGET_QUALIFIED_JOBS,
    dailyGreetingCap: raw.dailyGreetingCap ?? 5,
  };

  const queries: SearchQuery[] = [];
  for (const keyword of keywords) {
    if (queries.length >= MAX_INITIAL_QUERIES) break;
    queries.push({ cityName: contextCity, cityCode: context.cityCode, keyword, source: 'initial' });
  }

  return { goal, queries, warnings, mentionedCities, conflict: { conflict: others.length > 0, others } };
}

function uniqStrings(arr: string[]): string[] {
  const out: string[] = [];
  for (const x of arr) {
    const v = String(x ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 调用模型生成 Plan（唯一入口） */
export async function planJobSearch(
  client: ModelClient,
  rawGoal: string,
  context: BrowserContext,
): Promise<{
  goal: JobSearchGoal;
  queries: SearchQuery[];
  warnings: string[];
  mentionedCities: string[];
  successCriteria: AgentPlan['successCriteria'];
}> {
  const raw = (await client.chatJson(plannerSchema, buildPlannerSystem(), buildPlannerUser(rawGoal))) as PlannerOutput;
  const { goal, queries, warnings, mentionedCities } = normalizePlan(raw, rawGoal, context);
  return {
    goal,
    queries,
    warnings,
    mentionedCities,
    successCriteria: {
      targetQualifiedJobs: goal.targetQualifiedJobs,
      qualifiedScoreThreshold: DEFAULT_QUALIFIED_SCORE_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// Replan：只允许新增 keyword；城市/薪资/排除项/上限一律以原 goal 为准
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
    '- 只能新增搜索 keyword；禁止修改城市、薪资下限、hardExclusions、softNegativePreferences、每日上限',
    '- 判定规则（必须严格遵守）：当「≥75 分数量」<「目标高匹配岗位数」时，必须返回 status="continue" 并给出 2~4 个新关键词',
    '- 只有当 ≥75 分数量已达标时，才允许返回 status="complete" 且 newKeywords 为空',
    '- 不允许用"放宽条件"（取消 hardExclusions / 降低薪资）来凑数量',
    '',
    `当前固定条件（不可修改）：城市=${goal.cities.map((c) => c.name).join('、')}，薪资下限=${goal.salaryMinK ?? '不限'}K，硬排除=${goal.hardExclusions.join('、') || '无'}`,
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

/** 新关键词按"当前城市×关键词"展开，跳过已搜索组合，总数受 MAX_REPLAN_QUERIES 限制 */
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
  if (input.resultSummary.strongMatchCount >= target) {
    return { status: 'complete', reason: `已有 ${input.resultSummary.strongMatchCount} 个 ≥75 分岗位，达到目标 ${target}。`, newQueries: [] };
  }
  if ((input.replanCount ?? 0) >= 1) {
    return { status: 'complete', reason: '已达到 Replan 上限（最多 1 次），本轮结束。', newQueries: [] };
  }

  const raw = (await client.chatJson(replanSchema, buildReplanSystem(input.goal), buildReplanUser(input))) as ReplanOutput;
  if (raw.status === 'complete') {
    return { status: 'complete', reason: raw.reason || '模型判断无需补充搜索。', newQueries: [] };
  }
  const { queries } = expandReplanQueries(input.goal, input.searchedQueries, raw.newKeywords ?? []);
  if (!queries.length) {
    return { status: 'complete', reason: '没有可用的新搜索组合（可能都已搜索过），本轮结束。', newQueries: [] };
  }
  return { status: 'continue', reason: raw.reason || '补充搜索词以增加覆盖。', newQueries: queries };
}
