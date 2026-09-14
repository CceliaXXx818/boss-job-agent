// autopilot-runtime.js —— V0.5 Phase 3：Autopilot 持久化运行时状态
//
// 为什么必须持久化：Background Service Worker 随时可能被 suspend，
// 因此 runtime 只放**可 JSON 化**的数据，每推进一步就写回 chrome.storage.local。
//
// 严禁写入：DOM 节点、Chrome live 对象、函数、不可序列化结构。

export const RUNTIME_KEY = 'jobAgentAutopilotRuntime';

export const RUNTIME_VERSION = 1;

/** Day State Machine（V0.5 §6） */
export const AUTOPILOT_STATUS = Object.freeze({
  IDLE: 'IDLE',
  PLANNING: 'PLANNING',
  DISCOVERING: 'DISCOVERING',
  SCORING: 'SCORING',
  OUTREACH: 'OUTREACH',
  OUTREACH_COMPLETE: 'OUTREACH_COMPLETE',
  MONITORING: 'MONITORING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
});

/** 每个 tick 最多推进一个 bounded step */
export const AUTOPILOT_STEPS = Object.freeze({
  NONE: 'NONE',
  PLAN: 'PLAN',
  SEARCH_QUERY: 'SEARCH_QUERY',
  FILTER: 'FILTER',
  FETCH_DETAIL: 'FETCH_DETAIL',
  SCORE: 'SCORE',
  EVALUATE: 'EVALUATE',
  REPLAN: 'REPLAN',
  OUTREACH_CREATE: 'OUTREACH_CREATE',
  OUTREACH_EXECUTE: 'OUTREACH_EXECUTE',
  ROUND_END: 'ROUND_END',
  NEXT_ROUND_PLAN: 'NEXT_ROUND_PLAN',
  FINISH: 'FINISH',
});

export const RISK_REASONS = Object.freeze({
  USER_PAUSED: 'USER_PAUSED',
  CAPTCHA: 'CAPTCHA',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  RISK_PAGE: 'RISK_PAGE',
  BROWSER_TOOL_FAILURE_THRESHOLD: 'BROWSER_TOOL_FAILURE_THRESHOLD',
  AUTOPILOT_TAB_UNAVAILABLE: 'AUTOPILOT_TAB_UNAVAILABLE',
  AI_SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
  BROWSER_CONTEXT_INVALID: 'BROWSER_CONTEXT_INVALID',
  OUTSIDE_WORKING_HOURS: 'OUTSIDE_WORKING_HOURS',
  CONSENT_INVALID: 'CONSENT_INVALID',
  MODE_INVALID: 'MODE_INVALID',
  TEMPLATE_INVALID: 'TEMPLATE_INVALID',
  SETTINGS_INVALID: 'SETTINGS_INVALID',
  DAILY_CAP_REACHED: 'DAILY_CAP_REACHED',
});

/** 停止推进的状态：tick 直接返回，不做任何浏览器操作 */
export const TERMINAL_STATUSES = Object.freeze([
  AUTOPILOT_STATUS.MONITORING,
  AUTOPILOT_STATUS.OUTREACH_COMPLETE,
  AUTOPILOT_STATUS.STOPPED,
  AUTOPILOT_STATUS.IDLE,
]);

export function isActiveStatus(status) {
  return !TERMINAL_STATUSES.includes(status) && status !== AUTOPILOT_STATUS.PAUSED && status !== AUTOPILOT_STATUS.ERROR;
}

export function isPaused(status) {
  return status === AUTOPILOT_STATUS.PAUSED || status === AUTOPILOT_STATUS.ERROR;
}

/** 每轮 Detail 抓取上限（与 V0.4 sidepanel 保持一致） */
export const DETAIL_FETCH_LIMIT = 15;
/** 单轮发现事件上限（防止一个分区被写爆） */
export const MAX_ROUND_DISCOVERED = 200;

export function emptyRuntime(now = new Date()) {
  const iso = now.toISOString();
  return {
    version: RUNTIME_VERSION,
    sessionId: null,
    date: localDate(now),
    status: AUTOPILOT_STATUS.IDLE,
    step: AUTOPILOT_STEPS.NONE,

    rawGoal: null,
    goal: null,
    browserContext: null,

    roundIndex: 0,
    maxDiscoveryRounds: 3,
    maxReplanPerRound: 1,
    batchQualifiedTarget: 10,
    dailyGreetingCap: 5,
    minimumAutoGreetingScore: 80,
    workingHours: { start: '09:00', end: '18:00' },

    currentPlan: null,
    hardExclusions: [],
    searchedQueries: [],
    pendingQueries: [],
    currentQueryIndex: 0,
    replanCount: 0,

    currentRoundStats: emptyRoundStats(1),
    roundDiscovered: [],
    roundQualified: [],
    detailTargets: [],
    currentDetailIndex: 0,
    detailBuffer: [],
    scoredBuffer: [],
    recommendedJobIds: [],
    eligibleJobIds: [],
    eligibleRejectSamples: [],
    detailsStoppedEarly: false,
    outreachQueue: [],
    actionsCreatedFor: [],

    seenJobIds: [],
    fetchedDetailIds: [],
    todayGreetingCount: 0,

    activeActionId: null,
    paused: false,
    pauseReason: null,

    autopilotTabId: null,
    tabFailureCount: 0,
    consecutiveToolFailures: 0,
    consecutivePageFailures: 0,
    skippedDetailJobs: [],
    detailTargetsSkipped: [],
    lastRisk: null,

    startedAt: null,
    completedAt: null,
    updatedAt: iso,
    lastStepAt: null,
    lastError: null,
    log: [],
  };
}

export function emptyRoundStats(roundIndex) {
  return {
    roundIndex,
    searchedQueries: [],
    discoveredCount: 0,
    newDiscoveredCount: 0,
    filteredCount: 0,
    analyzedCount: 0,
    recommendedCount: 0,
    eligibleCount: 0,
    roundTarget: 0,
    replanCount: 0,
  };
}

export function localDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 只保留可 JSON 化的数据（防御性：任何 live 对象都会被丢掉） */
export function sanitizeRuntime(runtime) {
  try {
    return JSON.parse(JSON.stringify(runtime));
  } catch {
    return emptyRuntime();
  }
}

// ---------------- 存储 ----------------

let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** @returns {Promise<any>} */
export async function loadRuntime() {
  const st = await chrome.storage.local.get(RUNTIME_KEY);
  const raw = st[RUNTIME_KEY];
  if (!raw || typeof raw !== 'object') return emptyRuntime();
  return { ...emptyRuntime(), ...raw };
}

/** @param {any} runtime @param {{now?: Date}} [opts] @returns {Promise<any>} */
export async function saveRuntime(runtime, { now = new Date() } = {}) {
  return withLock(async () => {
    const next = sanitizeRuntime({
      ...runtime,
      version: RUNTIME_VERSION,
      updatedAt: now.toISOString(),
    });
    await chrome.storage.local.set({ [RUNTIME_KEY]: next });
    return next;
  });
}

/**
 * 读-改-写（原子，避免 tick 之间互相覆盖）
 * @param {(runtime: any) => any} mutator
 * @param {{now?: Date}} [opts]
 * @returns {Promise<any>}
 */
export async function patchRuntime(mutator, { now = new Date() } = {}) {
  return withLock(async () => {
    const current = await loadRuntime();
    const draft = mutator({ ...current }) ?? current;
    const next = sanitizeRuntime({ ...draft, version: RUNTIME_VERSION, updatedAt: now.toISOString() });
    await chrome.storage.local.set({ [RUNTIME_KEY]: next });
    return next;
  });
}

/** 跨天重置：新的一天不继承昨天的轮次与候选 */
export function resetForNewDay(runtime, settings, now = new Date()) {
  return {
    ...emptyRuntime(now),
    sessionId: runtime.sessionId,
    autopilotTabId: runtime.autopilotTabId,
    maxDiscoveryRounds: settings.maxDiscoveryRounds,
    maxReplanPerRound: settings.maxReplanPerRound,
    batchQualifiedTarget: settings.batchQualifiedTarget,
    dailyGreetingCap: settings.dailyGreetingCap,
    minimumAutoGreetingScore: settings.minimumAutoGreetingScore,
    workingHours: settings.workingHours,
  };
}

/** 用户可读的 activity 行（只保留最近 40 条，避免 runtime 无限增长） */
export function appendLog(runtime, text, now = new Date()) {
  const log = Array.isArray(runtime.log) ? runtime.log : [];
  const line = { at: now.toISOString(), text: String(text) };
  return [...log, line].slice(-40);
}

export async function clearRuntime() {
  await chrome.storage.local.set({ [RUNTIME_KEY]: emptyRuntime() });
  return { ok: true };
}
