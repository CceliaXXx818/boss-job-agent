// discovery-runner.js —— V0.5 Phase 3：Discovery 核心（Review 与 Autopilot 共用）
//
// 目标（V0.5 §8）：把 V0.4 里"Search → Filter → Detail → Score → Evaluate → Replan"的
// **执行内核**抽出来，Background SW 与 Side Panel 都调用同一套，禁止复制出
// autopilotSearch()/autopilotScore()/autopilotReplan() 这种第二份实现。
//
// 本模块只包含纯函数与极薄的编排辅助：
//   · 不碰 DOM、不碰 chrome.tabs、不发 HTTP
//   · 浏览器 I/O 与 HTTP 由调用方注入（callback / adapter）
//   · UI 更新通过 onProgress 回调，模块本身不认识 render/appendActivity

import {
  hardFilter,
  mergeHardExclusions,
  selectDetailTargets,
  rankJobs,
  shouldReplan,
  applyReplanQueries,
  MAX_REPLAN,
  DETAIL_FETCH_LIMIT,
  DEFAULT_QUALIFIED_SCORE_THRESHOLD,
} from './core-logic.js';

export { DETAIL_FETCH_LIMIT, MAX_REPLAN, DEFAULT_QUALIFIED_SCORE_THRESHOLD };

/**
 * @typedef {{
 *   jobId: string, title?: string|null, company?: string|null, href?: string|null,
 *   salary?: string|null, city?: string|null, tags?: string|null, area?: string|null,
 *   asciiSalary?: string|null, expEdu?: string[]|null, companyMeta?: string[]|null,
 *   descFull?: string|null, fromQuery?: string|null, removedReason?: string,
 *   __ai?: {ok?: boolean, score?: number, tier?: string, reasons?: string[], concerns?: string[]}|null
 * }} JobRow
 */

/** @typedef {{cityName?: string, cityCode?: string, keyword: string, source?: string, round?: number}} Query */

/** @typedef {{
 *   discoveredCount: number, qualifiedCount: number, strongMatchCount: number,
 *   topTitles: string[], rejectedReasons: string[]
 * }} ResultSummary */

/** 搜索 URL 构造（Side Panel 与 Background 共用同一规则） */
/** @param {Query} query @returns {string} */
export function buildSearchUrl(query) {
  return `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query.keyword)}&city=${query.cityCode}`;
}

/** @param {JobRow} job @returns {string} */
export function buildJobUrl(job) {
  return `https://www.zhipin.com${job.href}`;
}

/** 同一城市 + 同一关键词视为重复（V0.5 §25：跨轮不得重复搜同一个词） */
/** @param {{cityCode?: string|null, keyword?: string|null}} query @returns {string} */
export function queryKey(query) {
  return `${query?.cityCode ?? ''}|${String(query?.keyword ?? '').trim().toLowerCase()}`;
}

/** @param {Query[]} candidates @param {Query[]} [alreadySearched] @returns {Query[]} */
export function dedupeQueries(candidates, alreadySearched = []) {
  const seen = new Set(alreadySearched.map(queryKey));
  const out = [];
  for (const q of candidates ?? []) {
    if (!q?.keyword) continue;
    const key = queryKey(q);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** 合并一次搜索的抓取结果（按 jobId 去重，保留首次出现的信息） */
/**
 * @param {JobRow[]} existing @param {JobRow[]} rows @param {{fromQuery?: string|null}} [opts]
 * @returns {{jobs: JobRow[], added: number}}
 */
export function mergeSearchRows(existing, rows, { fromQuery = null } = {}) {
  const map = new Map((existing ?? []).map((j) => [j.jobId, j]));
  let added = 0;
  for (const row of rows ?? []) {
    if (!row?.jobId || map.has(row.jobId)) continue;
    map.set(row.jobId, fromQuery ? { ...row, fromQuery } : { ...row });
    added++;
  }
  return { jobs: [...map.values()], added };
}

/** 过滤掉今天已经处理过的岗位（跨轮 dedupe，V0.5 §26） */
/** @param {JobRow[]} jobs @param {string[]} [seenJobIds] @returns {JobRow[]} */
export function excludeSeen(jobs, seenJobIds = []) {
  const seen = new Set(seenJobIds);
  return (jobs ?? []).filter((j) => j?.jobId && !seen.has(j.jobId));
}

/**
 * 一轮的硬过滤（规则优先级高于任何模型分数）。
 * @returns {{qualified: JobRow[], removed: JobRow[], removedCount: number}}
 */
/**
 * @param {JobRow[]} jobs @param {{hardExclusions?: string[], seenJobIds?: string[]}} [opts]
 * @returns {{qualified: JobRow[], removed: JobRow[], removedCount: number}}
 */
export function filterRound(jobs, { hardExclusions = [], seenJobIds = [] } = {}) {
  const candidates = excludeSeen(jobs, seenJobIds);
  const qualified = [];
  const removed = [];
  for (const job of candidates) {
    const r = hardFilter(job, hardExclusions);
    if (r.pass) qualified.push(job);
    else removed.push({ ...job, removedReason: r.reason ?? '命中硬排除' });
  }
  return { qualified, removed, removedCount: removed.length };
}

/** 本轮需要抓详情的岗位（不超过 DETAIL_FETCH_LIMIT，已抓过的跳过） */
/** @param {JobRow[]} qualified @param {string[]} [fetchedDetailIds] @param {number} [limit] @returns {JobRow[]} */
export function pickDetailTargets(qualified, fetchedDetailIds = [], limit = DETAIL_FETCH_LIMIT) {
  return selectDetailTargets(qualified ?? [], new Set(fetchedDetailIds ?? []), limit);
}

/** 合并详情抓取结果（列表字段 + 详情字段，expEdu 回退到列表标签） */
/** @param {JobRow} job @param {any} detail @returns {JobRow} */
export function mergeDetail(job, detail) {
  return {
    ...job,
    ...(detail ?? {}),
    expEdu: detail?.expEdu?.length ? detail.expEdu : String(job?.tags ?? '').split('|').filter(Boolean),
  };
}

/** 分数映射回岗位（保留 AI 结果字段名 __ai，与 V0.4 一致） */
/** @param {JobRow[]} jobs @param {Array<{jobId: string, ok?: boolean, score?: number, tier?: string}>} results @returns {JobRow[]} */
export function attachScores(jobs, results) {
  const byId = new Map((results ?? []).map((r) => [r?.jobId, r]));
  return (jobs ?? []).map((j) => ({ ...j, __ai: byId.get(j.jobId) ?? j.__ai ?? null }));
}

/** 达标岗位（>= 75 分） */
/** @param {JobRow[]} scoredJobs @param {number} [threshold] @returns {JobRow[]} */
export function strongMatches(scoredJobs, threshold = DEFAULT_QUALIFIED_SCORE_THRESHOLD) {
  return (scoredJobs ?? [])
    .filter((j) => j?.__ai?.ok && Number(j.__ai.score) >= threshold)
    .sort((a, b) => Number(b.__ai.score) - Number(a.__ai.score));
}

/** /replan 的 resultSummary（Review 与 Autopilot 共用同一口径） */
/** @param {{discoveredCount?: number, qualifiedCount?: number, strongMatchCount?: number, topTitles?: string[], filteredOut?: number}} [input] @returns {ResultSummary} */
export function buildResultSummary({
  discoveredCount = 0,
  qualifiedCount = 0,
  strongMatchCount = 0,
  topTitles = [],
  filteredOut = 0,
} = {}) {
  return {
    discoveredCount,
    qualifiedCount,
    strongMatchCount,
    topTitles: (topTitles ?? []).slice(0, 8),
    rejectedReasons: [`命中排除词后累计移除 ${filteredOut} 个`],
  };
}

/** 是否触发 Replan（沿 V0.4 规则：达标数不足 且 本阶段还没 Replan 过） */
/** @param {{qualifiedCount: number, targetQualifiedJobs: number, replanCount: number, maxReplan?: number}} input @returns {boolean} */
export function needsReplan({ qualifiedCount, targetQualifiedJobs, replanCount, maxReplan = MAX_REPLAN }) {
  return shouldReplan({ qualifiedCount, targetQualifiedJobs, replanCount, maxReplan });
}

/**
 * 合并 replan 产生的新查询（过滤掉今天已搜过的 city+keyword）。
 * 只允许新增 keyword：城市、硬约束、薪资下限、上限参数都由既有 plan 决定（V0.5 §14）。
 * @returns {{queries: object[], added: object[], dropped: object[]}}
 */
/** @param {{existingQueries?: Query[], newQueries?: Query[], searchedQueries?: Query[], cityCode?: string, cityName?: string, maxAdd?: number}} [input] @returns {{queries: Query[], added: Query[], dropped: object[]}} */
export function mergeReplanQueries({ existingQueries = [], newQueries = [], searchedQueries = [], cityCode, cityName, maxAdd } = {}) {
  const fresh = dedupeQueries(newQueries ?? [], [...(searchedQueries ?? []), ...(existingQueries ?? [])]);
  if (!fresh.length) return { queries: existingQueries ?? [], added: [], dropped: [] };
  const { queries, dropped } = applyReplanQueries({
    existingQueries: [...(existingQueries ?? []), ...(searchedQueries ?? [])],
    newKeywords: fresh.map((q) => q.keyword),
    cityCode,
    cityName,
    ...(maxAdd ? { maxAdd } : {}),
  });
  return { queries: [...(existingQueries ?? []), ...queries], added: queries, dropped };
}

/**
 * 一轮结束后的推进决策（纯函数，便于测试）。
 * @returns {{action: 'NEXT_ROUND'|'COMPLETE', reason: string, code: string}}
 */
/** @param {{todayGreetingCount?: number, dailyGreetingCap?: number, roundIndex?: number, maxDiscoveryRounds?: number, withinWorkingHours?: boolean, roundHasNewCandidates?: boolean, hasNewQueries?: boolean}} [input] @returns {{action: 'NEXT_ROUND'|'COMPLETE', reason: string, code: string}} */
export function decideAfterRound({
  todayGreetingCount = 0,
  dailyGreetingCap = 5,
  roundIndex = 1,
  maxDiscoveryRounds = 3,
  withinWorkingHours = true,
  roundHasNewCandidates = false,
  hasNewQueries = false,
} = {}) {
  if (todayGreetingCount >= dailyGreetingCap) {
    return { action: 'COMPLETE', reason: `已达今日上限 ${dailyGreetingCap}`, code: 'DAILY_CAP_REACHED' };
  }
  if (roundIndex >= maxDiscoveryRounds) {
    return { action: 'COMPLETE', reason: `已达最大搜索轮次 ${maxDiscoveryRounds}`, code: 'MAX_ROUNDS_REACHED' };
  }
  if (!withinWorkingHours) {
    return { action: 'COMPLETE', reason: '已超出工作时间', code: 'OUTSIDE_WORKING_HOURS' };
  }
  if (!roundHasNewCandidates && !hasNewQueries) {
    return { action: 'COMPLETE', reason: '本轮没有新的候选岗位与搜索词', code: 'NO_NEW_RESULTS' };
  }
  return { action: 'NEXT_ROUND', reason: '继续下一轮补充搜索', code: 'CONTINUE' };
}

/** 岗位排序（预算允许时用于挑选最该联系的候选） */
/** @param {JobRow[]} jobs @returns {JobRow[]} */
export function rankCandidates(jobs) {
  return rankJobs(jobs ?? []);
}

/** 从候选里挑出本批要进入 Action Queue 的岗位（上限 = 今日剩余额度） */
/** @param {JobRow[]} recommended @param {{remaining?: number, alreadyQueued?: string[], alreadyGreeted?: string[]}} [opts] @returns {JobRow[]} */
export function pickOutreachCandidates(recommended, { remaining = 0, alreadyQueued = [], alreadyGreeted = [] } = {}) {
  const queued = new Set(alreadyQueued);
  const greeted = new Set(alreadyGreeted);
  const out = [];
  for (const job of rankCandidates(recommended)) {
    if (out.length >= Math.max(0, remaining)) break;
    if (!job?.jobId || queued.has(job.jobId) || greeted.has(job.jobId)) continue;
    out.push(job);
  }
  return out;
}

/**
 * 纯编排辅助：把"一轮"表达为 step 序列，Background 与测试共用。
 * 每调用一次 advance() 只执行一个 step（V0.5 §15）。
 */
/** @param {{queries?: Query[], detailTargets?: JobRow[]}} [input] @returns {object} */
export function createRoundPlan({ queries = [], detailTargets = [] } = {}) {
  return {
    queries: queries.length,
    detailTargets: detailTargets.length,
    steps: ['SEARCH_QUERY', 'FILTER', 'FETCH_DETAIL', 'SCORE', 'EVALUATE'],
    note: '每个 step 由调用方按 bounded 方式执行，执行完立即 persist',
  };
}

/** 合并排除词（画像 + Goal 硬约束） */
/** @param {string[]} [candidateExclude] @param {string[]} [goalHardExclusions] @returns {string[]} */
export function resolveHardExclusions(candidateExclude = [], goalHardExclusions = []) {
  return mergeHardExclusions(candidateExclude, goalHardExclusions);
}
