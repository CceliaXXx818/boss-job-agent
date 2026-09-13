// daily-report-service.js —— V0.5 Phase 4：日报的持久化与调度（storage 包装，逻辑尽量薄）
//
// 职责：
//   · 读取"当天分区 + Job State + Runtime + settings"，交给 report-builder 生成结构化日报
//   · 正式日报幂等落盘（jobAgentDailyReport:YYYY-MM-DD）+ DAILY_REPORT_GENERATED 事件
//   · catch-up：Chrome 18:00 没开着时，下次唤醒补生成（同一天最多一份正式日报）
//   · alarm 时间计算（一次性 alarm，不用长驻 timer）
//
// 只读 Event / State / Runtime；除 DAILY_REPORT_GENERATED 事件与日报 snapshot 外，
// **不修改任何运行状态**（V0.5 §38）。

import { EVENT_TYPES, appendEvent, getEventsByDate, hasEvent, localDateKey } from './event-store.js';
import { getAllJobStates } from './job-state.js';
import { loadRuntime } from './autopilot-runtime.js';
import { isValidHHMM, loadSettings } from './settings.js';
import { buildDailyReport, REPORT_VERSION } from './report-builder.js';

export const SNAPSHOT_PREFIX = 'jobAgentDailyReport:';
export const REPORT_ALARM = 'jobAgentDailyReportAlarm';
export const DEFAULT_REPORT_TIME = '18:00';

export const snapshotKey = (date) => `${SNAPSHOT_PREFIX}${date}`;

const pad = (n) => String(n).padStart(2, '0');
export const hhmmLocal = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export function hhmmToMinutes(v) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 下一次该生成日报的时间：今天还没到就今天，否则明天 */
export function nextReportFireTime(now, timeHHMM) {
  const t = isValidHHMM(timeHHMM) ? timeHHMM : DEFAULT_REPORT_TIME;
  const [h, min] = t.split(':').map(Number);
  const fire = new Date(now);
  fire.setHours(h, min, 0, 0);
  if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1);
  return fire.getTime();
}

// ---------------- 读取输入 ----------------

/** @returns {Promise<{events: any[], jobStates: any, runtime: any, settings: any}>} */
export async function loadDayInputs(date) {
  const [events, jobStates, runtime, settings] = await Promise.all([
    getEventsByDate(date),
    getAllJobStates(),
    loadRuntime(),
    loadSettings(),
  ]);
  return { events, jobStates, runtime, settings };
}

/** 实时预览：不写任何东西（V0.5 §18） */
/**
 * @param {{date?: string|null, now?: Date}} [opts]
 * @returns {Promise<any>} 结构化日报
 */
export async function previewDailyReport({ date = null, now = new Date() } = {}) {
  const day = date ?? localDateKey(now);
  const { events, jobStates, runtime, settings } = await loadDayInputs(day);
  return buildDailyReport({ date: day, events, jobStates, settings, runtime, generatedAt: null });
}

// ---------------- Snapshot ----------------

/** @returns {Promise<{date: string, generatedAt: string, version: number, report: any}|null>} */
export async function getSnapshot(date) {
  const st = await chrome.storage.local.get(snapshotKey(date));
  const snap = st[snapshotKey(date)];
  if (!snap || typeof snap !== 'object') return null;
  return snap;
}

/** @param {{limit?: number}} [opts] @returns {Promise<string[]>} */
export async function listSnapshots({ limit = 30 } = {}) {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(SNAPSHOT_PREFIX))
    .map((k) => k.slice(SNAPSHOT_PREFIX.length))
    .sort()
    .slice(-limit);
}

/**
 * 正式生成一次（幂等）：
 *   · 已有 snapshot → 直接返回，不重复生成
 *   · 事件已存在（幂等键 report:<date>）但 snapshot 缺失 → 补写 snapshot，不重复写事件
 * @param {{date?: string|null, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, created: boolean, source: string, duplicateEvent?: boolean, snapshot: {date: string, generatedAt: string, version: number, report: any}}>}
 */
export async function generateDailyReportOnce({ date = null, now = new Date() } = {}) {
  const day = date ?? localDateKey(now);
  const existing = await getSnapshot(day);
  if (existing) {
    return { ok: true, created: false, source: 'snapshot', snapshot: existing };
  }

  const alreadyEvented = await hasEvent({ type: EVENT_TYPES.DAILY_REPORT_GENERATED, idempotencyKey: `report:${day}` });
  const { events, jobStates, runtime, settings } = await loadDayInputs(day);
  const generatedAt = now.toISOString();
  const report = buildDailyReport({ date: day, events, jobStates, settings, runtime, generatedAt });
  const snapshot = { date: day, generatedAt, version: REPORT_VERSION, report };
  await chrome.storage.local.set({ [snapshotKey(day)]: snapshot });

  const ev = await appendEvent({
    type: EVENT_TYPES.DAILY_REPORT_GENERATED,
    timestamp: generatedAt,
    jobId: null,
    idempotencyKey: `report:${day}`,
    metadata: {
      date: day,
      created: !alreadyEvented,
      summary: report.summary,
      outreach: {
        dailyCap: report.outreach.dailyCap,
        contacted: report.outreach.contacted,
        goalReached: report.outreach.goalReached,
        stopReason: report.outreach.stopReason,
      },
      rounds: report.summary.discoveryRounds,
      hasActivity: report.hasActivity,
      reportVersion: REPORT_VERSION,
    },
  });

  return {
    ok: true,
    created: true,
    source: alreadyEvented ? 'snapshot-recreated' : 'generated',
    duplicateEvent: ev.duplicate === true,
    snapshot,
  };
}

/** 删除某天 snapshot（调试/清理用；不删事件） */
/** @returns {Promise<{ok: boolean}>} */
export async function deleteSnapshot(date) {
  await chrome.storage.local.remove(snapshotKey(date));
  return { ok: true };
}

// ---------------- Catch-up ----------------

/**
 * 是否需要补生成（V0.5 §17）：
 *   日报关闭 / 还没到生成时间 / 今天已生成 → 不需要
 */
/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{needed: boolean, date: string, reason: string, reportTime?: string}>}
 */
export async function shouldCatchUp({ now = new Date() } = {}) {
  const settings = await loadSettings();
  const day = localDateKey(now);
  if (settings.dailyReportEnabled === false) {
    return { needed: false, date: day, reason: 'DISABLED' };
  }
  const nowMin = hhmmToMinutes(hhmmLocal(now));
  const targetMin = hhmmToMinutes(settings.dailyReportTime) ?? hhmmToMinutes(DEFAULT_REPORT_TIME);
  if (nowMin !== null && targetMin !== null && nowMin < targetMin) {
    return { needed: false, date: day, reason: 'BEFORE_REPORT_TIME', reportTime: settings.dailyReportTime };
  }
  if (await getSnapshot(day)) {
    return { needed: false, date: day, reason: 'SNAPSHOT_EXISTS' };
  }
  if (await hasEvent({ type: EVENT_TYPES.DAILY_REPORT_GENERATED, idempotencyKey: `report:${day}` })) {
    return { needed: false, date: day, reason: 'ALREADY_GENERATED' };
  }
  return { needed: true, date: day, reason: 'CATCH_UP', reportTime: settings.dailyReportTime };
}

/** 补生成（幂等；由 SW startup / Side Panel 打开 / Autopilot start 调用） */
/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, generated: boolean, date?: string, reason: string, snapshot?: any}>}
 */
export async function catchUpIfNeeded({ now = new Date() } = {}) {
  const check = await shouldCatchUp({ now });
  if (!check.needed) return { ok: true, generated: false, ...check };
  const res = await generateDailyReportOnce({ date: check.date, now });
  return { ok: true, generated: res.created, date: check.date, reason: check.reason, snapshot: res.snapshot };
}

// ---------------- Alarm ----------------

/** 保证存在"下一次日报时间"的一次性 alarm（不用周期 alarm / setInterval） */
/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, scheduled: boolean, when?: number, at?: string, reason?: string}>}
 */
export async function ensureDailyReportAlarm({ now = new Date() } = {}) {
  const settings = await loadSettings();
  if (settings.dailyReportEnabled === false) {
    await chrome.alarms.clear(REPORT_ALARM);
    return { ok: true, scheduled: false, reason: 'DISABLED' };
  }
  const when = nextReportFireTime(now, settings.dailyReportTime);
  await chrome.alarms.create(REPORT_ALARM, { when });
  return { ok: true, scheduled: true, when, at: new Date(when).toISOString() };
}
