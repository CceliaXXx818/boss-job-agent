// event-store.js —— V0.5 Phase 2：事件存储（append-oriented / 幂等 / 可审计 / 可被 SW 使用）
//
// 设计要点（对应 V0.5 要求 §3-§5）：
//  1. 按日期分区：jobAgentEvents:YYYY-MM-DD，避免"单个无限增长的数组"每次 append 都要全量读写。
//  2. 幂等索引：jobAgentIdempotency = { [idempotencyKey]: {eventId, date, type, jobId, critical} }。
//  3. 元数据：jobAgentEventMeta = { version, retentionDays, dates:{[date]:count}, totalEvents, ... }。
//  4. 副作用类事件（GREETING_SENT / RESUME_SENT）的幂等键在 retention 清理后**仍然保留**，
//     保证"同一个岗位不会被重复打招呼"这个安全保证不随时间失效（键很小，可长期保留）。
//  5. 不依赖 Side Panel 内存：所有读写都直接走 chrome.storage.local，Phase 3 的 background SW 可直接复用。
//
// 本模块只负责"记录发生过什么"，不做业务判断、不发起任何外部动作。

/**
 * 事件基础 schema（V0.5 §3）：所有事件都必须有 eventId 与 type；
 * 有副作用的关键事件必须有 idempotencyKey。
 * @typedef {{
 *   eventId: string,
 *   timestamp: string,
 *   type: string,
 *   jobId: string|null,
 *   company: string|null,
 *   jobTitle: string|null,
 *   metadata: Record<string, unknown>,
 *   idempotencyKey: string|null
 * }} StoredEvent
 */

export const EVENT_TYPES = Object.freeze({
  // 运行与发现
  DISCOVERY_ROUND_STARTED: 'DISCOVERY_ROUND_STARTED',
  DISCOVERY_ROUND_COMPLETED: 'DISCOVERY_ROUND_COMPLETED',
  JOB_DISCOVERED: 'JOB_DISCOVERED',
  JOB_SCORED: 'JOB_SCORED',
  JOB_SHORTLISTED: 'JOB_SHORTLISTED',
  // Action Queue
  ACTION_CREATED: 'ACTION_CREATED',
  ACTION_APPROVED: 'ACTION_APPROVED',
  ACTION_SKIPPED: 'ACTION_SKIPPED',
  ACTION_REQUIRES_MANUAL: 'ACTION_REQUIRES_MANUAL',
  // 外部副作用（关键事件）
  GREETING_SENT: 'GREETING_SENT',
  GREETING_FAILED: 'GREETING_FAILED',
  RESUME_SENT: 'RESUME_SENT',
  RESUME_REQUESTED: 'RESUME_REQUESTED',
  HR_REPLIED: 'HR_REPLIED',
  NEEDS_MANUAL_REPLY: 'NEEDS_MANUAL_REPLY',
  INTERVIEW: 'INTERVIEW',
  REJECTED: 'REJECTED',
  OFFER: 'OFFER',
  // 控制面
  MODE_CHANGED: 'MODE_CHANGED',
  CONSENT_GRANTED: 'CONSENT_GRANTED',
  CONSENT_REVOKED: 'CONSENT_REVOKED',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  AGENT_PAUSED: 'AGENT_PAUSED',
  AGENT_RESUMED: 'AGENT_RESUMED',
  DAILY_REPORT_GENERATED: 'DAILY_REPORT_GENERATED',
});

/** 有外部副作用的类型：其幂等键永久保留（§Idempotency 安全保证） */
export const CRITICAL_IDEMPOTENT_TYPES = Object.freeze([
  EVENT_TYPES.GREETING_SENT,
  EVENT_TYPES.RESUME_SENT,
]);

const CRITICAL_SET = new Set(CRITICAL_IDEMPOTENT_TYPES);

export const EVENT_PREFIX = 'jobAgentEvents:';
export const META_KEY = 'jobAgentEventMeta';
export const IDEMPOTENCY_KEY = 'jobAgentIdempotency';
export const DEFAULT_RETENTION_DAYS = 30;

// ---------------- 日期工具 ----------------

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期键 YYYY-MM-DD（用户的"今天"按本地时区算，日报/上限都以此为准） */
export function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTC 日期键：仅用于兼容 V0.4 旧 key（旧代码用 toISOString().slice(0,10)） */
export function utcDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 日期字符串偏移（days 可为负） */
export function shiftDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return localDateKey(dt);
}

export function isValidDateKey(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ---------------- 并发写锁 ----------------
// Side Panel 与（未来）SW 可能同时 append；storage 的读-改-写必须串行，否则会丢事件。
let writeChain = Promise.resolve();

function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------- 存储原语 ----------------

const storageGet = async (keys) => {
  const st = await chrome.storage.local.get(keys);
  return st ?? {};
};
const storageSet = async (obj) => {
  await chrome.storage.local.set(obj);
};

function emptyMeta() {
  return {
    version: 1,
    retentionDays: DEFAULT_RETENTION_DAYS,
    dates: {},
    totalEvents: 0,
    lastPrunedAt: null,
    updatedAt: null,
  };
}

async function readMeta() {
  const st = await storageGet(META_KEY);
  const meta = st[META_KEY];
  if (!meta || typeof meta !== 'object') return emptyMeta();
  return { ...emptyMeta(), ...meta, dates: { ...(meta.dates ?? {}) } };
}

async function readIndex() {
  const st = await storageGet(IDEMPOTENCY_KEY);
  const idx = st[IDEMPOTENCY_KEY];
  return idx && typeof idx === 'object' ? { ...idx } : {};
}

/** 只允许可 JSON 化的纯数据进入事件（禁止把 Service/DOM/函数塞进 metadata） */
/** @param {unknown} value @returns {Record<string, unknown>} */
export function toPlainData(value) {
  if (value == null) return {};
  try {
    const plain = JSON.parse(JSON.stringify(value));
    if (plain && typeof plain === 'object' && !Array.isArray(plain)) return plain;
    return { value: plain };
  } catch {
    return {};
  }
}

function makeEventId() {
  const rnd =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `evt_${Date.now().toString(36)}_${rnd}`;
}

function normalizeEvent(event, timestamp) {
  if (!event || typeof event !== 'object') throw new Error('appendEvent: event 必须是对象');
  const type = String(event.type ?? '').trim();
  if (!type) throw new Error('appendEvent: event.type 必填');
  return {
    eventId: typeof event.eventId === 'string' && event.eventId ? event.eventId : makeEventId(),
    timestamp: typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : timestamp,
    type,
    jobId: event.jobId ?? null,
    company: event.company ?? null,
    jobTitle: event.jobTitle ?? null,
    metadata: toPlainData(event.metadata),
    idempotencyKey: event.idempotencyKey ? String(event.idempotencyKey) : null,
  };
}

// ---------------- 写入 ----------------

/**
 * 追加单个事件。
 * @param {Partial<StoredEvent> & {type: string}} event
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, appended: boolean, duplicate: boolean, event: StoredEvent}>}
 *          幂等命中时 appended=false, duplicate=true（调用方不应重复记副作用）
 */
export async function appendEvent(event, { now = new Date() } = {}) {
  return withLock(async () => {
    const meta = await readMeta();
    const index = await readIndex();
    const timestamp = now instanceof Date ? now.toISOString() : String(now);
    const record = normalizeEvent(event, timestamp);

    if (record.idempotencyKey && index[record.idempotencyKey]) {
      return {
        ok: true,
        appended: false,
        duplicate: true,
        event: { ...record, eventId: index[record.idempotencyKey].eventId },
      };
    }

    const date = localDateKey(new Date(record.timestamp));
    const key = `${EVENT_PREFIX}${date}`;
    const st = await storageGet(key);
    const partition = Array.isArray(st[key]) ? [...st[key]] : [];
    partition.push(record);

    meta.dates[date] = (meta.dates[date] ?? 0) + 1;
    meta.totalEvents = (meta.totalEvents ?? 0) + 1;
    meta.updatedAt = timestamp;

    if (record.idempotencyKey) {
      index[record.idempotencyKey] = {
        eventId: record.eventId,
        date,
        type: record.type,
        jobId: record.jobId,
        critical: CRITICAL_SET.has(record.type),
      };
    }

    await storageSet({ [key]: partition, [META_KEY]: meta, [IDEMPOTENCY_KEY]: index });
    return { ok: true, appended: true, duplicate: false, event: record };
  });
}

/**
 * 批量追加（一次分区写入，用于发现/评分这类成批事件）。
 * 幂等语义与 appendEvent 一致：已存在的 idempotencyKey 会被跳过。
 * @param {Array<Partial<StoredEvent> & {type: string}>} events
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, appended: number, duplicates: number, events: StoredEvent[]}>}
 */
export async function appendEvents(events, { now = new Date() } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { ok: true, appended: 0, duplicates: 0, events: [] };
  return withLock(async () => {
    const meta = await readMeta();
    const index = await readIndex();
    const timestamp = now instanceof Date ? now.toISOString() : String(now);

    const byDate = new Map();
    const added = [];
    let duplicates = 0;

    for (const raw of list) {
      const record = normalizeEvent(raw, timestamp);
      if (record.idempotencyKey && index[record.idempotencyKey]) {
        duplicates++;
        continue;
      }
      const date = localDateKey(new Date(record.timestamp));
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(record);
      added.push(record);
      if (record.idempotencyKey) {
        index[record.idempotencyKey] = {
          eventId: record.eventId,
          date,
          type: record.type,
          jobId: record.jobId,
          critical: CRITICAL_SET.has(record.type),
        };
      }
    }

    if (!added.length) return { ok: true, appended: 0, duplicates, events: [] };

    const patch = {};
    for (const [date, records] of byDate) {
      const key = `${EVENT_PREFIX}${date}`;
      const st = await storageGet(key);
      const partition = Array.isArray(st[key]) ? [...st[key]] : [];
      partition.push(...records);
      patch[key] = partition;
      meta.dates[date] = (meta.dates[date] ?? 0) + records.length;
    }
    meta.totalEvents = (meta.totalEvents ?? 0) + added.length;
    meta.updatedAt = timestamp;
    patch[META_KEY] = meta;
    patch[IDEMPOTENCY_KEY] = index;
    await storageSet(patch);
    return { ok: true, appended: added.length, duplicates, events: added };
  });
}

// ---------------- 读取 ----------------

/** @returns {Promise<StoredEvent[]>} */
export async function getEventsByDate(dateKey) {
  if (!isValidDateKey(dateKey)) return [];
  const key = `${EVENT_PREFIX}${dateKey}`;
  const st = await storageGet(key);
  return Array.isArray(st[key]) ? st[key] : [];
}

/** @returns {Promise<string[]>} */
export async function getEventDates() {
  const meta = await readMeta();
  return Object.keys(meta.dates ?? {}).sort();
}

/** @returns {Promise<{version: number, retentionDays: number, dates: Record<string, number>, totalEvents: number, lastPrunedAt: string|null, updatedAt: string|null}>} */
export async function getEventMeta() {
  return readMeta();
}

/**
 * 按 Job 聚合事件（跨所有已保留分区，按时间升序）
 * @returns {Promise<StoredEvent[]>}
 */
export async function getEventsByJob(jobId, { limit = 500 } = {}) {
  if (!jobId) return [];
  const dates = await getEventDates();
  const all = [];
  for (const date of dates) {
    const events = await getEventsByDate(date);
    for (const e of events) if (e.jobId === jobId) all.push(e);
  }
  all.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return all.slice(-limit);
}

/**
 * 幂等查询。
 * - 给 idempotencyKey：命中即 true（并校验 type/jobId 是否一致）
 * - 只给 type（+可选 jobId）：扫描已保留分区
 */
/**
 * @param {{type?: string|null, jobId?: string|null, idempotencyKey?: string|null}} [query]
 * @returns {Promise<boolean>}
 */
export async function hasEvent({ type = null, jobId = null, idempotencyKey = null } = {}) {
  if (idempotencyKey) {
    const index = await readIndex();
    const hit = index[idempotencyKey];
    if (!hit) return false;
    if (type && hit.type !== type) return false;
    if (jobId && hit.jobId !== jobId) return false;
    return true;
  }
  if (!type) return false;
  const dates = await getEventDates();
  for (const date of dates) {
    const events = await getEventsByDate(date);
    if (events.some((e) => e.type === type && (jobId ? e.jobId === jobId : true))) return true;
  }
  return false;
}

/**
 * 区间聚合（用于日报/统计，不返回原始事件，避免把大数组搬进 UI）
 * @param {{startDate?: string, endDate?: string}} [range]
 * @returns {Promise<{startDate: string|null, endDate: string|null, total: number, byType: Record<string, number>, byDate: Record<string, number>, discovered: number, scored: number, shortlisted: number, greetingSent: number, greetingFailed: number}>}
 */
export async function aggregateEvents({ startDate, endDate } = {}) {
  const dates = await getEventDates();
  const from = isValidDateKey(startDate) ? startDate : dates[0];
  const to = isValidDateKey(endDate) ? endDate : dates[dates.length - 1];
  const byType = {};
  const byDate = {};
  let total = 0;
  for (const date of dates) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const events = await getEventsByDate(date);
    byDate[date] = events.length;
    total += events.length;
    for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  }
  return {
    startDate: from ?? null,
    endDate: to ?? null,
    total,
    byType,
    byDate,
    discovered: byType[EVENT_TYPES.JOB_DISCOVERED] ?? 0,
    scored: byType[EVENT_TYPES.JOB_SCORED] ?? 0,
    shortlisted: byType[EVENT_TYPES.JOB_SHORTLISTED] ?? 0,
    greetingSent: byType[EVENT_TYPES.GREETING_SENT] ?? 0,
    greetingFailed: byType[EVENT_TYPES.GREETING_FAILED] ?? 0,
  };
}

// ---------------- 清理 ----------------

/**
 * 按保留天数清理分区（默认 30 天）。
 * 关键点：有副作用的幂等键（GREETING_SENT / RESUME_SENT）**不删除**，
 * 否则清理后可能出现"重复打招呼"。旧事件本身会被删除。
 */
/**
 * @param {{retentionDays?: number, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, cutoff: string, removedDates: string[], removedEvents: number, removedIndexEntries: number, keptCriticalKeys: number, retentionDays: number}>}
 */
export async function pruneEvents({ retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  return withLock(async () => {
    const meta = await readMeta();
    const index = await readIndex();
    const today = localDateKey(now);
    const cutoff = shiftDateKey(today, -Math.abs(Number(retentionDays) || DEFAULT_RETENTION_DAYS));

    const removedDates = [];
    const removeKeys = [];
    let removedEvents = 0;
    for (const date of Object.keys(meta.dates ?? {})) {
      if (date >= cutoff) continue;
      removedDates.push(date);
      removeKeys.push(`${EVENT_PREFIX}${date}`);
      removedEvents += meta.dates[date] ?? 0;
      delete meta.dates[date];
    }

    let removedIndexEntries = 0;
    let keptCriticalKeys = 0;
    for (const [key, entry] of Object.entries(index)) {
      if (!entry || !removedDates.includes(entry.date)) continue;
      if (entry.critical) {
        keptCriticalKeys++;
        index[key] = { ...entry, pruned: true };
        continue;
      }
      delete index[key];
      removedIndexEntries++;
    }

    meta.retentionDays = Math.abs(Number(retentionDays) || DEFAULT_RETENTION_DAYS);
    meta.lastPrunedAt = now instanceof Date ? now.toISOString() : String(now);
    meta.totalEvents = Object.values(meta.dates).reduce((a, b) => a + b, 0);

    const patch = { [META_KEY]: meta, [IDEMPOTENCY_KEY]: index };
    if (removeKeys.length) {
      await chrome.storage.local.remove(removeKeys);
    }
    await storageSet(patch);

    return {
      ok: true,
      cutoff,
      removedDates,
      removedEvents,
      removedIndexEntries,
      keptCriticalKeys,
      retentionDays: meta.retentionDays,
    };
  });
}

/** 测试/调试用：清空所有事件分区与索引（不影响 Job State / Action Queue） */
export async function clearAllEvents() {
  return withLock(async () => {
    const meta = await readMeta();
    const keys = Object.keys(meta.dates ?? {}).map((d) => `${EVENT_PREFIX}${d}`);
    if (keys.length) await chrome.storage.local.remove(keys);
    await storageSet({ [META_KEY]: emptyMeta(), [IDEMPOTENCY_KEY]: {} });
    return { ok: true, removed: keys.length };
  });
}
