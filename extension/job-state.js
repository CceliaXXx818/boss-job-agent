// job-state.js —— V0.5 Phase 2：岗位状态机（持久化在 chrome.storage.local）
//
// 职责边界：
//   Event Store 记录"发生过什么"；本模块记录"当前是什么状态"。
//   两者由 agent-records.js 的统一 helper 一起写入，避免各模块各自维护导致不一致。
//
// 不做过度设计：只做"状态 + 合法转移守卫 + 持久化"，不做重试/调度（那是 Action Queue 与 Phase 3 的事）。

export const STATES = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  FILTERED: 'FILTERED',
  SCORED: 'SCORED',
  SHORTLISTED: 'SHORTLISTED',
  GREETED: 'GREETED',
  HR_REPLIED: 'HR_REPLIED',
  RESUME_REQUESTED: 'RESUME_REQUESTED',
  RESUME_SENT: 'RESUME_SENT',
  NEEDS_MANUAL_REPLY: 'NEEDS_MANUAL_REPLY',
  INTERVIEW: 'INTERVIEW',
  REJECTED: 'REJECTED',
  OFFER: 'OFFER',
});

export const ALL_STATES = Object.freeze(Object.values(STATES));

/** Phase 2 实际使用这四个（其余状态已预留，Phase 4-7 启用） */
export const PHASE2_STATES = Object.freeze([
  STATES.DISCOVERED,
  STATES.SCORED,
  STATES.SHORTLISTED,
  STATES.GREETED,
]);

/**
 * 合法转移表：只允许列出的目标状态。
 * 终态（REJECTED / OFFER）没有出口。
 */
export const TRANSITIONS = Object.freeze({
  [STATES.DISCOVERED]: [STATES.FILTERED, STATES.SCORED],
  [STATES.FILTERED]: [],
  [STATES.SCORED]: [STATES.SHORTLISTED, STATES.REJECTED],
  [STATES.SHORTLISTED]: [STATES.GREETED, STATES.REJECTED],
  [STATES.GREETED]: [STATES.HR_REPLIED, STATES.REJECTED],
  [STATES.HR_REPLIED]: [
    STATES.RESUME_REQUESTED,
    STATES.NEEDS_MANUAL_REPLY,
    STATES.INTERVIEW,
    STATES.REJECTED,
  ],
  [STATES.RESUME_REQUESTED]: [STATES.RESUME_SENT, STATES.NEEDS_MANUAL_REPLY],
  // 人工处理完成后可以回到正常轨道（用户手动回复后重新判定）
  [STATES.NEEDS_MANUAL_REPLY]: [
    STATES.HR_REPLIED,
    STATES.RESUME_SENT,
    STATES.INTERVIEW,
    STATES.REJECTED,
  ],
  [STATES.RESUME_SENT]: [STATES.INTERVIEW, STATES.REJECTED, STATES.OFFER],
  [STATES.INTERVIEW]: [STATES.OFFER, STATES.REJECTED],
  [STATES.REJECTED]: [],
  [STATES.OFFER]: [],
});

/** 从事件类型推导目标状态（null = 该事件不改变岗位状态） */
export const EVENT_TO_STATE = Object.freeze({
  JOB_DISCOVERED: STATES.DISCOVERED,
  JOB_SCORED: STATES.SCORED,
  JOB_SHORTLISTED: STATES.SHORTLISTED,
  GREETING_SENT: STATES.GREETED,
  HR_REPLIED: STATES.HR_REPLIED,
  RESUME_REQUESTED: STATES.RESUME_REQUESTED,
  RESUME_SENT: STATES.RESUME_SENT,
  NEEDS_MANUAL_REPLY: STATES.NEEDS_MANUAL_REPLY,
  INTERVIEW: STATES.INTERVIEW,
  REJECTED: STATES.REJECTED,
  OFFER: STATES.OFFER,
  // GREETING_FAILED 明确不改变状态：失败绝不等于 GREETED
});

export const JOB_STATES_KEY = 'jobAgentJobStates';
const MAX_TRANSITIONS_KEPT = 20;

export function isKnownState(state) {
  return ALL_STATES.includes(state);
}

/** 合法转移判定（同状态视为无变化，不算非法） */
export function canTransition(from, to) {
  if (!isKnownState(to)) return { ok: false, reason: `未知状态：${to}` };
  if (from == null) return { ok: true, changed: true, reason: null }; // 首次记录
  if (from === to) return { ok: true, changed: false, reason: null };
  if (!isKnownState(from)) return { ok: false, reason: `未知状态：${from}` };
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `非法状态转移：${from} → ${to}（允许：${allowed.join('、') || '无'}）` };
  }
  return { ok: true, changed: true, reason: null };
}

export function nextStatesOf(state) {
  return [...(TRANSITIONS[state] ?? [])];
}

/** 从 from 走到 target 的最短合法路径（含 target；不可达返回 null） */
export function pathTo(from, target) {
  if (!isKnownState(target)) return null;
  // 首次记录（from=null）不能直接跳到 GREETED：从 DISCOVERED 开始走完整合法链路
  if (from == null) {
    if (target === STATES.DISCOVERED) return [STATES.DISCOVERED];
    const rest = pathTo(STATES.DISCOVERED, target);
    return rest ? [STATES.DISCOVERED, ...rest] : null;
  }
  if (from === target) return [];
  const queue = [[from, []]];
  const seen = new Set([from]);
  while (queue.length) {
    const [cur, path] = queue.shift();
    for (const next of TRANSITIONS[cur] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === target) return nextPath;
      seen.add(next);
      queue.push([next, nextPath]);
    }
  }
  return null;
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

async function readAll() {
  const st = await chrome.storage.local.get(JOB_STATES_KEY);
  const all = st[JOB_STATES_KEY];
  return all && typeof all === 'object' ? { ...all } : {};
}

/**
 * @typedef {{jobId: string, state: string, company: string|null, jobTitle: string|null,
 *   firstSeenAt: string, updatedAt: string,
 *   transitions: Array<{from: string|null, to: string, at: string, reason: string|null}>}} JobStateRecord
 */

/** @returns {Promise<Record<string, JobStateRecord>>} */
export async function getAllJobStates() {
  return readAll();
}

/** @returns {Promise<JobStateRecord|null>} */
export async function getJobState(jobId) {
  if (!jobId) return null;
  const all = await readAll();
  return all[jobId] ?? null;
}

/** @returns {Promise<string[]>} */
export async function getJobIdsByState(state) {
  const all = await readAll();
  return Object.values(all)
    .filter((r) => r?.state === state)
    .map((r) => r.jobId);
}

/** @returns {Promise<Record<string, number>>} */
export async function countByState() {
  const all = await readAll();
  const out = {};
  for (const r of Object.values(all)) {
    if (!r?.state) continue;
    out[r.state] = (out[r.state] ?? 0) + 1;
  }
  return out;
}

/**
 * 设置岗位状态（带守卫）。
 * @param {{jobId: string, state: string, company?: string|null, jobTitle?: string|null, reason?: string|null, at?: string|null}} input
 * @returns {Promise<{ok: boolean, changed: boolean, state: string|null, previous: string|null, reason: string|null}>}
 *          非法转移返回 ok:false，且**不写入**任何内容。
 */
export async function setJobState({ jobId, state, company = null, jobTitle = null, reason = null, at = null }) {
  if (!jobId) return { ok: false, changed: false, state: null, previous: null, reason: 'jobId 必填' };
  return withLock(async () => {
    const all = await readAll();
    const current = all[jobId] ?? null;
    const previous = current?.state ?? null;
    const guard = canTransition(previous, state);
    if (!guard.ok) {
      return { ok: false, changed: false, state: previous, previous, reason: guard.reason };
    }

    const timestamp = at ?? new Date().toISOString();
    const record = {
      jobId,
      state,
      company: company ?? current?.company ?? null,
      jobTitle: jobTitle ?? current?.jobTitle ?? null,
      firstSeenAt: current?.firstSeenAt ?? timestamp,
      updatedAt: timestamp,
      transitions: [
        ...(current?.transitions ?? []),
        ...(guard.changed ? [{ from: previous, to: state, at: timestamp, reason }] : []),
      ].slice(-MAX_TRANSITIONS_KEPT),
    };

    all[jobId] = record;
    await chrome.storage.local.set({ [JOB_STATES_KEY]: all });
    return { ok: true, changed: guard.changed, state, previous, reason: null };
  });
}

/**
 * 确保岗位到达目标状态：若当前状态无法直接到达，则沿合法路径补齐中间状态。
 * 用途：Review 只在 Shortlist 上打招呼，但如果因为历史数据缺失而没有 SHORTLISTED 记录，
 *       这里会按 DISCOVERED → SCORED → SHORTLISTED 的合法路径补齐，而不是伪造非法跳转。
 * 注意：首次记录（无历史状态）也会从 DISCOVERED 开始补齐，不会一步跳到 GREETED。
 * @param {{jobId: string, state: string, company?: string|null, jobTitle?: string|null, reason?: string}} input
 * @returns {Promise<{ok: boolean, state: string|null, steps: string[], reason: string|null}>}
 */
export async function ensureJobState({ jobId, state, company = null, jobTitle = null, reason = 'path-completed' }) {
  const current = await getJobState(jobId);
  const from = current?.state ?? null;
  const path = pathTo(from, state);
  if (!path) {
    return { ok: false, state: from, steps: [], reason: `无法从 ${from ?? '未记录'} 到达 ${state}` };
  }
  const steps = [];
  for (const next of path) {
    const r = await setJobState({ jobId, state: next, company, jobTitle, reason });
    if (!r.ok) return { ok: false, state: r.state, steps, reason: r.reason };
    if (r.changed) steps.push(next);
  }
  return { ok: true, state, steps, reason: null };
}

/** 清理长期未更新的岗位状态（默认保留 180 天；Phase 2 不主动调用，留给后续阶段） */
export async function pruneJobStates({ retentionDays = 180, now = new Date() } = {}) {
  return withLock(async () => {
    const all = await readAll();
    const cutoff = new Date(now.getTime() - Math.abs(retentionDays) * 86400_000).toISOString();
    const removed = [];
    for (const [jobId, r] of Object.entries(all)) {
      if ((r?.updatedAt ?? '') < cutoff) {
        delete all[jobId];
        removed.push(jobId);
      }
    }
    await chrome.storage.local.set({ [JOB_STATES_KEY]: all });
    return { ok: true, removed };
  });
}

/** 测试/调试用 */
export async function clearAllJobStates() {
  await chrome.storage.local.set({ [JOB_STATES_KEY]: {} });
  return { ok: true };
}
