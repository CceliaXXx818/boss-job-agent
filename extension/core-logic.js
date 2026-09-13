// core-logic.js —— Job Agent 的纯逻辑层（无 DOM、无 chrome API，可被单测直接覆盖）
// 设计原则：LLM 决定 WHAT，这里决定"规则上允许/不允许"，浏览器层决定 HOW。

/** fallback 映射（不再作为前置白名单；仅用于"有 code 但页面读不到名字"时兜底） */
export const KNOWN_CITY_CODES = Object.freeze({
  101020100: '上海',
  101010100: '北京',
  101210100: '杭州',
  101280600: '深圳',
  101280100: '广州',
  101270100: '成都',
  101190100: '南京',
  101200100: '武汉',
  101190400: '苏州',
  101110100: '西安',
});

/** name → code（由 KNOWN_CITY_CODES 反查；V0.4.1 起仅作 fallback，不再是搜索白名单） */
export const CITY_NAME_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(KNOWN_CITY_CODES).map(([code, name]) => [name, code])),
);

/** @deprecated V0.4.1：保留旧名以免破坏引用；语义已变为"已知城市映射"，不再拦截搜索 */
export const SUPPORTED_CITIES = CITY_NAME_TO_CODE;

const CITY_TEXT_RE = /^[\u4e00-\u9fa5]{2,8}(市|省|自治州)?$/;

/**
 * 解析 Browser Context（纯函数，便于单测）。
 * 优先级：URL 中的 city code（权威）→ 已知 code 映射名称 → DOM 城市文本。
 * 返回 null 表示无法识别（调用方应 STOPPED 提示用户）。
 */
export function resolveBossContext(page, knownCodes = KNOWN_CITY_CODES) {
  if (!page) return null;
  const code = String(page.codeFromUrl ?? '').trim();
  const domTexts = (page.domCandidates ?? [])
    .map((c) => String(c.text ?? '').trim())
    .filter((t) => CITY_TEXT_RE.test(t));
  // DOM 文本里优先"纯城市名"（不含"切换/城市"等词）
  const domName = domTexts.find((t) => !/切换|选择|城市|热门|更多/.test(t)) ?? '';
  let cityName = '';
  if (code && knownCodes[code]) cityName = knownCodes[code];
  if (!cityName && domName) cityName = domName.replace(/市$/, '');
  if (!cityName && code) cityName = `城市${code}`;
  if (!code && !cityName) return null;
  const pageType = /\/job_detail\//.test(page.url ?? '')
    ? 'job-detail'
    : /\/web\/geek\//.test(page.url ?? '')
      ? 'job-list'
      : 'unknown';
  return { platform: 'boss', cityName, cityCode: code || '', pageType, url: page.url ?? '' };
}

/** Goal 中提到的城市与当前 BOSS 城市是否冲突（Case C） */
export function detectCityConflict(mentionedCities, contextCityName) {
  const others = (mentionedCities ?? [])
    .map((c) => String(c ?? '').trim().replace(/市$/, ''))
    .filter((c) => c && c !== String(contextCityName ?? '').trim().replace(/市$/, ''));
  return others.length ? { conflict: true, others } : { conflict: false, others: [] };
}

export const DEFAULT_TARGET_QUALIFIED_JOBS = 10;
export const DEFAULT_QUALIFIED_SCORE_THRESHOLD = 75;
export const MAX_INITIAL_QUERIES = 6;
export const MAX_REPLAN = 1;
export const MAX_REPLAN_QUERIES = 4;
export const DETAIL_FETCH_LIMIT = 15;

/** 系统级硬排除（确定性，非用户可放宽） */
export const SYSTEM_HARD_EXCLUSIONS = Object.freeze(['数据标注', 'AI运营', '训练运营', '销售', '驻外', '外派', '纯运营', '标注']);

/** @deprecated 兼容旧名 */
export const DEFAULT_EXCLUDE_TOKENS = SYSTEM_HARD_EXCLUSIONS;

/** 规则排序加分词 */
export const BOOST_TOKENS = Object.freeze([
  'Agent', '大模型', 'LLM', 'RAG', 'Prompt', 'Conversational', '智能客服', '对话',
  '智能外呼', '智能质检', 'Workflow', 'Function Calling', 'AI Native',
]);

export function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr ?? []) {
    const v = String(x ?? '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * 最终硬排除 = 系统硬排除 + 候选人画像硬排除 + 本轮 Goal hardExclusions（去重）。
 * V0.4.1：softNegativePreferences 绝不进入这里（只能影响评分/排序/concerns）。
 */
export function mergeHardExclusions(candidateHard, goalHard) {
  return uniq([...(candidateHard ?? []), ...(goalHard ?? []), ...SYSTEM_HARD_EXCLUSIONS]).map((t) => t.toLowerCase());
}

/** @deprecated 兼容 V0.4.0 调用名 */
export function mergeExcludeTokens(candidateTokens, goalTokens) {
  return mergeHardExclusions(candidateTokens, goalTokens);
}

export function hardFilter(job, excludeTokens) {
  const blob = `${job.title ?? ''} ${job.company ?? ''} ${job.tags ?? ''} ${job.expEdu ?? ''}`.toLowerCase();
  for (const t of excludeTokens ?? []) {
    if (t && blob.includes(t)) return { pass: false, reason: `命中排除词「${t}」` };
  }
  return { pass: true };
}

/** 规则排序：仅用于"挑哪些去抓详情"，不决定最终推荐 */
export function rankJobs(jobs) {
  return [...jobs]
    .map((j) => {
      const upper = `${j.title ?? ''} ${j.tags ?? ''}`.toUpperCase();
      let score = 0;
      for (const t of BOOST_TOKENS) if (upper.includes(t.toUpperCase())) score += 2;
      if (String(j.tags ?? '').includes('5-10年')) score += 2;
      if (String(j.tags ?? '').includes('3-5年')) score += 1;
      return { ...j, rankScore: score };
    })
    .sort((a, b) => b.rankScore - a.rankScore || String(a.title).localeCompare(String(b.title), 'zh'));
}

/** 只对 Top N 且未抓过详情的岗位抓详情 */
export function selectDetailTargets(jobs, fetchedIds, limit = DETAIL_FETCH_LIMIT) {
  const done = fetchedIds instanceof Set ? fetchedIds : new Set(fetchedIds ?? []);
  return rankJobs(jobs)
    .filter((j) => !done.has(j.jobId))
    .slice(0, Math.max(0, limit));
}

/** 是否需要 Replan：结果不足 且 还没 Replan 过 */
export function shouldReplan({ qualifiedCount, targetQualifiedJobs, replanCount, maxReplan = MAX_REPLAN }) {
  return Number(qualifiedCount) < Number(targetQualifiedJobs) && Number(replanCount) < Number(maxReplan);
}

/**
 * Replan 只允许"新增 keyword"：城市不变、硬约束不可改。
 * 返回 { queries, dropped }，自动过滤已搜索 city+keyword 组合与超量项。
 */
export function applyReplanQueries({ existingQueries, newKeywords, cityCode, cityName, maxAdd = MAX_REPLAN_QUERIES }) {
  const searched = new Set((existingQueries ?? []).map((q) => `${q.cityCode}::${String(q.keyword).trim().toLowerCase()}`));
  const queries = [];
  const dropped = [];
  for (const raw of newKeywords ?? []) {
    const keyword = String(raw ?? '').trim();
    if (!keyword) continue;
    const key = `${cityCode}::${keyword.toLowerCase()}`;
    if (searched.has(key)) {
      dropped.push({ keyword, reason: '已搜索过' });
      continue;
    }
    if (queries.length >= maxAdd) {
      dropped.push({ keyword, reason: `超过单次新增上限 ${maxAdd}` });
      continue;
    }
    searched.add(key);
    queries.push({ cityName, cityCode, keyword, source: 'replan' });
  }
  return { queries, dropped };
}

/** 打招呼闸门：必须用户批准 + 未超日限 + 不在历史里 */
export function canGreet({ approved, dailyDone, dailyCap, jobId, history }) {
  if (!approved) return { ok: false, reason: '未获得用户批准' };
  if (Number(dailyDone) >= Number(dailyCap)) return { ok: false, reason: '已达今日上限' };
  const hist = history instanceof Set ? history : new Set(history ?? []);
  if (hist.has(jobId)) return { ok: false, reason: '历史已联系过' };
  return { ok: true };
}

/** 分数分档（与 packages/model-client/src/score.ts 保持一致） */
export function tierOf(score) {
  if (score >= 80) return 'hot';
  if (score >= 75) return 'apply';
  if (score >= 65) return 'review';
  return 'reject';
}

/** Planner 结果校验：城市必须在支持列表内，否则给出 warning 而不是乱猜 code */
export function validatePlan(plan, supported = SUPPORTED_CITIES) {
  const warnings = [];
  const cities = [];
  for (const c of plan?.cities ?? []) {
    const name = String(c?.name ?? '').trim();
    if (!name) continue;
    const code = supported[name];
    if (!code) {
      warnings.push(`暂不支持的城市：${name}（已跳过，未猜测 city code）`);
      continue;
    }
    cities.push({ name, code });
  }
  return { cities, warnings };
}

/** hh:mm 便于 Activity 时间线 */
export function hhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
