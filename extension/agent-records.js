// agent-records.js —— V0.5 Phase 2：统一记录 helper
//
// 目标（对应 V0.5 §7）：核心外部动作只走一个入口，内部同时负责
//   append Event（发生过什么） + update Job State（现在是什么状态） + legacy 兼容写入
// 避免 sidepanel / 未来的 SW 各自维护导致 Event 与 Job State 不一致。
//
// 所有 helper 都是幂等的：同一个 jobId 的 GREETING_SENT 只会真正写入一次。

import { EVENT_TYPES, appendEvent, appendEvents, getEventsByDate, hasEvent, localDateKey, utcDateKey } from './event-store.js';
import { STATES, ensureJobState, getJobState, setJobState } from './job-state.js';

export const LEGACY_DAILY_PREFIX = 'greet-';
export const LEGACY_HISTORY_KEY = 'greetedHistory';
/** 单轮发现事件上限：避免一次搜索把几百条事件写进分区（超出的用汇总事件记录） */
export const MAX_DISCOVERED_EVENTS_PER_ROUND = 60;

const nowIso = (at) => (at instanceof Date ? at.toISOString() : typeof at === 'string' && at ? at : new Date().toISOString());

// ---------------- legacy 兼容（只读旧 / 写双份） ----------------

/** 读取某天的打招呼次数：取 legacy 两个日期键与事件计数中的最大值（宁多算，不少算） */
export async function getDailyGreetingCount(date = new Date()) {
  const local = localDateKey(date);
  const utc = utcDateKey(date);
  const keys = [local, utc].filter(Boolean).map((d) => `${LEGACY_DAILY_PREFIX}${d}`);
  const st = await chrome.storage.local.get(keys);
  const legacyLocal = Number(st[`${LEGACY_DAILY_PREFIX}${local}`] ?? 0) || 0;
  const legacyUtc = Number(st[`${LEGACY_DAILY_PREFIX}${utc}`] ?? 0) || 0;
  const events = (await getEventsByDate(local)).filter((e) => e.type === EVENT_TYPES.GREETING_SENT).length;
  return {
    date: local,
    events,
    legacyLocal,
    legacyUtc,
    effective: Math.max(events, legacyLocal, legacyUtc),
  };
}

async function bumpLegacyCounters(date, at) {
  const local = localDateKey(at ?? date);
  const utc = utcDateKey(at ?? date);
  const keyLocal = `${LEGACY_DAILY_PREFIX}${local}`;
  const keyUtc = `${LEGACY_DAILY_PREFIX}${utc}`;
  const st = await chrome.storage.local.get([keyLocal, keyUtc]);
  const patch = { [keyLocal]: (Number(st[keyLocal] ?? 0) || 0) + 1 };
  if (keyUtc !== keyLocal) patch[keyUtc] = (Number(st[keyUtc] ?? 0) || 0) + 1;
  await chrome.storage.local.set(patch);
  return patch;
}

export async function getGreetedHistory() {
  const st = await chrome.storage.local.get(LEGACY_HISTORY_KEY);
  return new Set(Array.isArray(st[LEGACY_HISTORY_KEY]) ? st[LEGACY_HISTORY_KEY] : []);
}

async function addLegacyHistory(jobId) {
  const h = await getGreetedHistory();
  if (h.has(jobId)) return false;
  h.add(jobId);
  await chrome.storage.local.set({ [LEGACY_HISTORY_KEY]: [...h] });
  return true;
}

/** 是否联系过：Event Store 与 legacy history 任一命中即为真 */
export async function hasGreeted(jobId) {
  if (!jobId) return false;
  if (await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId, idempotencyKey: `greeting:${jobId}` })) return true;
  const h = await getGreetedHistory();
  return h.has(jobId);
}

// ---------------- 核心外部动作：打招呼 ----------------

/**
 * 记录一次成功的打招呼：GREETING_SENT + Job State → GREETED + legacy 兼容写入。
 * 幂等：同 jobId 已存在 GREETING_SENT 时不会再写事件，也不会再加计数。
 *
 * @param {{
 *   job: {jobId: string, title?: string|null, company?: string|null},
 *   message: string,
 *   messageStrategy?: {mode?: string, templateId?: string},
 *   templateId?: string,
 *   score?: number|null,
 *   actionId?: string|null,
 *   mode?: 'review'|'autopilot',
 *   roundIndex?: number|null,
 *   at?: Date|string
 * }} input
 */
export async function recordGreetingSuccess({
  job,
  message,
  messageStrategy = {},
  templateId = null,
  score = null,
  actionId = null,
  mode = 'review',
  roundIndex = null,
  at = null,
}) {
  const jobId = job?.jobId;
  if (!jobId) return { ok: false, duplicate: false, eventId: null, state: null, reason: 'jobId 必填' };
  const timestamp = nowIso(at);
  const idempotencyKey = `greeting:${jobId}`;

  const r = await appendEvent(
    {
      type: EVENT_TYPES.GREETING_SENT,
      timestamp,
      jobId,
      company: job.company ?? null,
      jobTitle: job.title ?? null,
      idempotencyKey,
      metadata: {
        message: String(message ?? ''),
        messageStrategy: {
          mode: messageStrategy?.mode ?? 'template',
          templateId: String(messageStrategy?.templateId ?? templateId ?? 'default'),
        },
        templateId: String(templateId ?? messageStrategy?.templateId ?? 'default'),
        messageLength: String(message ?? '').length,
        score: Number.isFinite(Number(score)) ? Number(score) : null,
        actionId: actionId ?? null,
        mode,
        // 日报按轮次归类用；Review 手动联系时为 null（日报退化为按时间窗归类）
        roundIndex: Number.isFinite(Number(roundIndex)) ? Number(roundIndex) : null,
      },
    },
    { now: new Date(timestamp) },
  );

  // Job State：先补齐合法路径（DISCOVERED → SCORED → SHORTLISTED）再到 GREETED
  const stateResult = await ensureJobState({
    jobId,
    state: STATES.GREETED,
    company: job.company ?? null,
    jobTitle: job.title ?? null,
    reason: 'GREETING_SENT',
  });

  if (r.appended) {
    await bumpLegacyCounters(null, timestamp);
    await addLegacyHistory(jobId);
  }

  return {
    ok: true,
    duplicate: r.duplicate,
    eventId: r.event?.eventId ?? null,
    state: stateResult.ok ? stateResult.state : null,
    stateSteps: stateResult.steps ?? [],
    reason: stateResult.ok ? null : stateResult.reason,
  };
}

/**
 * 记录一次失败的打招呼：GREETING_FAILED（不改变岗位状态，绝不标成 GREETED）
 * @param {{
 *   job?: {jobId: string, title?: string|null, company?: string|null}|null,
 *   error?: string,
 *   stage?: string|null,
 *   actionId?: string|null,
 *   mode?: 'review'|'autopilot',
 *   at?: Date|string|null
 * }} input
 * @returns {Promise<{ok: boolean, duplicate: boolean, eventId: string|null, state: string|null}>}
 */
export async function recordGreetingFailure({
  job,
  error = '未知错误',
  stage = null,
  actionId = null,
  mode = 'review',
  at = null,
}) {
  const jobId = job?.jobId ?? null;
  const timestamp = nowIso(at);
  const r = await appendEvent(
    {
      type: EVENT_TYPES.GREETING_FAILED,
      timestamp,
      jobId,
      company: job?.company ?? null,
      jobTitle: job?.title ?? null,
      // 失败可能反复发生，只对同一个 Action 去重
      idempotencyKey: actionId ? `greeting-failed:${actionId}` : null,
      metadata: { error: String(error), stage: stage ? String(stage) : null, actionId: actionId ?? null, mode },
    },
    { now: new Date(timestamp) },
  );
  const state = jobId ? await getJobState(jobId) : null;
  return { ok: true, duplicate: r.duplicate, eventId: r.event?.eventId ?? null, state: state?.state ?? null };
}

// ---------------- 运行过程事件 ----------------

/** 记录一次发现的候选岗位（通过硬过滤的），并写入 Job State = DISCOVERED */
export async function recordJobsDiscovered({ jobs, round = 1, mode = 'review', limit = MAX_DISCOVERED_EVENTS_PER_ROUND, at = null }) {
  const list = Array.isArray(jobs) ? jobs : [];
  const timestamp = nowIso(at);
  const head = list.slice(0, Math.max(0, limit));
  const overflow = list.length - head.length;

  const res = await appendEvents(
    head.map((j) => ({
      type: EVENT_TYPES.JOB_DISCOVERED,
      timestamp,
      jobId: j.jobId,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      idempotencyKey: `discovered:${j.jobId}`,
      metadata: {
        round,
        mode,
        salary: j.salary ?? null,
        city: j.city ?? null,
        tags: j.__tags ?? null,
        href: j.href ?? null,
      },
    })),
    { now: new Date(timestamp) },
  );

  for (const j of head) {
    await setJobState({
      jobId: j.jobId,
      state: STATES.DISCOVERED,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      reason: `discovery-round-${round}`,
      at: timestamp,
    });
  }

  if (overflow > 0) {
    await appendEvent({
      type: EVENT_TYPES.DISCOVERY_ROUND_COMPLETED,
      timestamp,
      jobId: null,
      metadata: { round, mode, discovered: list.length, recorded: head.length, overflow },
    });
  }
  return { ok: true, recorded: res.appended, duplicates: res.duplicates, overflow };
}

/** 记录评分结果，Job State = SCORED */
export async function recordJobsScored({ jobs, mode = 'review', at = null }) {
  const list = Array.isArray(jobs) ? jobs : [];
  const timestamp = nowIso(at);
  const res = await appendEvents(
    list.map((j) => ({
      type: EVENT_TYPES.JOB_SCORED,
      timestamp,
      jobId: j.jobId,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      idempotencyKey: `scored:${j.jobId}`,
      metadata: { mode, score: j.__ai?.score ?? null, tier: j.__ai?.tier ?? null, href: j.href ?? null },
    })),
    { now: new Date(timestamp) },
  );
  for (const j of list) {
    await setJobState({
      jobId: j.jobId,
      state: STATES.SCORED,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      reason: 'scored',
      at: timestamp,
    });
  }
  return { ok: true, recorded: res.appended, duplicates: res.duplicates };
}

/** 记录进入 Shortlist，Job State = SHORTLISTED */
export async function recordJobsShortlisted({ jobs, mode = 'review', at = null }) {
  const list = Array.isArray(jobs) ? jobs : [];
  const timestamp = nowIso(at);
  const res = await appendEvents(
    list.map((j) => ({
      type: EVENT_TYPES.JOB_SHORTLISTED,
      timestamp,
      jobId: j.jobId,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      idempotencyKey: `shortlisted:${j.jobId}:${localDateKey(new Date(timestamp))}`,
      metadata: { mode, score: j.__ai?.score ?? null, href: j.href ?? null },
    })),
    { now: new Date(timestamp) },
  );
  for (const j of list) {
    await setJobState({
      jobId: j.jobId,
      state: STATES.SHORTLISTED,
      company: j.company ?? null,
      jobTitle: j.title ?? null,
      reason: 'shortlist',
      at: timestamp,
    });
  }
  return { ok: true, recorded: res.appended, duplicates: res.duplicates };
}

export async function recordDiscoveryRound({ round, queries = [], discovered = 0, passed = 0, mode = 'review', at = null }) {
  const timestamp = nowIso(at);
  const r = await appendEvent({
    type: EVENT_TYPES.DISCOVERY_ROUND_STARTED,
    timestamp,
    jobId: null,
    idempotencyKey: `round:${localDateKey(new Date(timestamp))}:${round}`,
    metadata: { round, mode, queries, discovered, passed },
  });
  return { ok: true, eventId: r.event?.eventId ?? null, duplicate: r.duplicate };
}

// ---------------- 控制面事件（审计用） ----------------

export async function recordModeChange({ mode, previous = null, at = null }) {
  return appendEvent({
    type: EVENT_TYPES.MODE_CHANGED,
    timestamp: nowIso(at),
    jobId: null,
    metadata: { mode, previous },
  });
}

export async function recordConsent({ granted, kind = 'autopilot', template = null, at = null }) {
  return appendEvent({
    type: granted ? EVENT_TYPES.CONSENT_GRANTED : EVENT_TYPES.CONSENT_REVOKED,
    timestamp: nowIso(at),
    jobId: null,
    metadata: { kind, templateLength: template ? String(template).length : null },
  });
}

export async function recordSettingsUpdated({ changed = {}, at = null } = {}) {
  return appendEvent({
    type: EVENT_TYPES.SETTINGS_UPDATED,
    timestamp: nowIso(at),
    jobId: null,
    metadata: { changed },
  });
}
