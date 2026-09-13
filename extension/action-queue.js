// action-queue.js —— V0.5 Phase 2：Action Queue（持久化在 chrome.storage.local）
//
// 为什么必须持久化：Phase 3 的 background SW 会消费同一个队列；Side Panel 关闭或 SW 被回收后
// 队列必须仍可恢复。因此这里不保存任何 DOM/函数引用，只保存可 JSON 化的数据。
//
// Review 与未来的 Autopilot 共用同一个队列，区别只在"谁把 pending 变成 approved"：
//   Review   ：用户点确认
//   Autopilot：Policy 判定通过（Phase 3）
//
// 幂等：idempotencyKey 在创建时确定（如 greeting:{jobId}）；执行前还会再查 Event Store，
//       防止"重复点击 / 页面刷新 / Side Panel 重开"导致重复打招呼。

import { EVENT_TYPES, appendEvent, hasEvent } from './event-store.js';

/**
 * @typedef {{
 *   actionId: string,
 *   type: string,
 *   jobId: string,
 *   company: string|null,
 *   jobTitle: string|null,
 *   createdAt: string,
 *   updatedAt: string,
 *   status: string,
 *   mode: string,
 *   attempts: number,
 *   approvedAt: string|null,
 *   executedAt: string|null,
 *   finishedAt: string|null,
 *   lastError: string|null,
 *   eventId: string|null,
 *   skipReason?: string,
 *   manualReason?: string,
 *   payload: {
 *     score: number|null,
 *     message: string,
 *     messageStrategy: {mode: string, templateId: string},
 *     templateId: string,
 *     href: string|null
 *   },
 *   idempotencyKey: string
 * }} AgentAction
 */

export const ACTIONS_KEY = 'jobAgentActions';
export const LEGACY_HISTORY_KEY = 'greetedHistory';
export const MAX_ACTIONS_KEPT = 300;
export const DEFAULT_ACTION_RETENTION_DAYS = 30;

export const ACTION_TYPES = Object.freeze({
  GREETING: 'GREETING',
  RESUME: 'RESUME',
});

export const ACTION_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  REQUIRES_MANUAL: 'requires_manual',
});

/** 这些状态表示"同类动作已经被占用或已经完成"，不允许再创建重复 Action */
export const BLOCKING_STATUSES = Object.freeze([
  ACTION_STATUS.PENDING,
  ACTION_STATUS.APPROVED,
  ACTION_STATUS.EXECUTING,
  ACTION_STATUS.SUCCESS,
]);

export const TERMINAL_STATUSES = Object.freeze([
  ACTION_STATUS.SUCCESS,
  ACTION_STATUS.FAILED,
  ACTION_STATUS.SKIPPED,
  ACTION_STATUS.REQUIRES_MANUAL,
]);

/** Action 自身状态机（单一出口：终态不再变化，需要重试就新建 Action） */
export const ACTION_TRANSITIONS = Object.freeze({
  [ACTION_STATUS.PENDING]: [ACTION_STATUS.APPROVED, ACTION_STATUS.SKIPPED],
  [ACTION_STATUS.APPROVED]: [ACTION_STATUS.EXECUTING, ACTION_STATUS.SKIPPED, ACTION_STATUS.REQUIRES_MANUAL],
  [ACTION_STATUS.EXECUTING]: [
    ACTION_STATUS.SUCCESS,
    ACTION_STATUS.FAILED,
    ACTION_STATUS.REQUIRES_MANUAL,
  ],
  [ACTION_STATUS.SUCCESS]: [],
  [ACTION_STATUS.FAILED]: [],
  [ACTION_STATUS.SKIPPED]: [],
  [ACTION_STATUS.REQUIRES_MANUAL]: [],
});

export function isBlockingStatus(status) {
  return BLOCKING_STATUSES.includes(status);
}

export function canTransitionAction(from, to) {
  if (!Object.values(ACTION_STATUS).includes(to)) return { ok: false, reason: `未知 Action 状态：${to}` };
  if (from === to) return { ok: true, changed: false, reason: null };
  const allowed = ACTION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `非法 Action 转移：${from} → ${to}（允许：${allowed.join('、') || '无'}）` };
  }
  return { ok: true, changed: true, reason: null };
}

/** V0.4 旧去重记录（greetedHistory）：只读，用来在创建阶段就拦住已联系过的岗位 */
async function inLegacyGreetedHistory(jobId) {
  const st = await chrome.storage.local.get(LEGACY_HISTORY_KEY);
  const list = st[LEGACY_HISTORY_KEY];
  return Array.isArray(list) && list.includes(jobId);
}

export function greetingIdempotencyKey(jobId) {
  return `greeting:${jobId}`;
}
export function resumeIdempotencyKey(jobId) {
  return `resume:${jobId}`;
}
export function reportIdempotencyKey(dateKey) {
  return `report:${dateKey}`;
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

/** @returns {Promise<AgentAction[]>} */
async function readActions() {
  const st = await chrome.storage.local.get(ACTIONS_KEY);
  const list = st[ACTIONS_KEY];
  return Array.isArray(list) ? list.map((a) => ({ ...a })) : [];
}

/** @param {AgentAction[]} list */
async function writeActions(list) {
  await chrome.storage.local.set({ [ACTIONS_KEY]: list });
}

function makeActionId(type) {
  const rnd =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `act_${String(type).toLowerCase()}_${Date.now().toString(36)}_${rnd}`;
}

/** @returns {Promise<AgentAction[]>} */
export async function getAllActions() {
  return readActions();
}

/** @returns {Promise<AgentAction|null>} */
export async function getAction(actionId) {
  const list = await readActions();
  return list.find((a) => a.actionId === actionId) ?? null;
}

/**
 * @param {{status?: string|null, type?: string|null}} [filter]
 * @returns {Promise<AgentAction[]>}
 */
export async function getActions({ status = null, type = null } = {}) {
  const list = await readActions();
  return list.filter((a) => (!status || a.status === status) && (!type || a.type === type));
}

/** @returns {Promise<AgentAction[]>} */
export async function getActionsForJob(jobId) {
  const list = await readActions();
  return list.filter((a) => a.jobId === jobId);
}

/** 队列概览（给 UI 用的小对象，不返回全部原始数据） */
export async function summarizeActions() {
  const list = await readActions();
  const byStatus = {};
  for (const a of list) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  return {
    total: list.length,
    byStatus,
    pending: byStatus[ACTION_STATUS.PENDING] ?? 0,
    approved: byStatus[ACTION_STATUS.APPROVED] ?? 0,
    executing: byStatus[ACTION_STATUS.EXECUTING] ?? 0,
    success: byStatus[ACTION_STATUS.SUCCESS] ?? 0,
    failed: byStatus[ACTION_STATUS.FAILED] ?? 0,
    skipped: byStatus[ACTION_STATUS.SKIPPED] ?? 0,
    requiresManual: byStatus[ACTION_STATUS.REQUIRES_MANUAL] ?? 0,
  };
}

// ---------------- 创建 ----------------

/**
 * 为选中的岗位创建 GREETING Action（状态 pending，message 在此刻固化）。
 * 已经存在阻塞状态 Action 或已有 GREETING_SENT 事件的岗位会被跳过。
 *
 * @param {{
 *   jobs: Array<{jobId: string, title?: string, company?: string, href?: string, score?: number}>,
 *   message: string,
 *   strategy?: {mode?: string, templateId?: string},
 *   mode?: 'review'|'autopilot',
 *   now?: Date
 * }} input
 * @returns {Promise<{ok: boolean, created: AgentAction[], skipped: Array<{jobId: string|null, reason: string}>}>}
 */
export async function createGreetingActions({ jobs, message, strategy = {}, mode = 'review', now = new Date() }) {
  const list = Array.isArray(jobs) ? jobs : [];
  const createdAt = now instanceof Date ? now.toISOString() : String(now);
  return withLock(async () => {
    const existing = await readActions();
    const created = [];
    const skipped = [];

    for (const job of list) {
      const jobId = job?.jobId;
      if (!jobId) {
        skipped.push({ jobId: null, reason: '缺少 jobId' });
        continue;
      }
      const idempotencyKey = greetingIdempotencyKey(jobId);

      if (created.some((a) => a.idempotencyKey === idempotencyKey)) {
        skipped.push({ jobId, reason: '本次提交中重复选中' });
        continue;
      }
      const blocking = existing.find((a) => a.idempotencyKey === idempotencyKey && isBlockingStatus(a.status));
      if (blocking) {
        skipped.push({ jobId, reason: `已有同类 Action（${blocking.status}）` });
        continue;
      }
      if (await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId, idempotencyKey })) {
        skipped.push({ jobId, reason: '该岗位已有 GREETING_SENT 记录' });
        continue;
      }
      if (await inLegacyGreetedHistory(jobId)) {
        skipped.push({ jobId, reason: '该岗位在 V0.4 历史记录（greetedHistory）中已联系过' });
        continue;
      }

      const action = {
        actionId: makeActionId(ACTION_TYPES.GREETING),
        type: ACTION_TYPES.GREETING,
        jobId,
        company: job.company ?? null,
        jobTitle: job.title ?? null,
        createdAt,
        updatedAt: createdAt,
        status: ACTION_STATUS.PENDING,
        mode,
        attempts: 0,
        approvedAt: null,
        executedAt: null,
        finishedAt: null,
        lastError: null,
        eventId: null,
        payload: {
          score: Number.isFinite(Number(job.score)) ? Number(job.score) : null,
          message: String(message ?? ''),
          messageStrategy: {
            mode: strategy.mode ?? 'template',
            templateId: String(strategy.templateId ?? 'default'),
          },
          templateId: String(strategy.templateId ?? 'default'),
          href: job.href ?? null,
        },
        idempotencyKey,
      };
      created.push(action);
      existing.push(action);
    }

    if (created.length) await writeActions(existing);

    for (const a of created) {
      await appendEvent({
        type: EVENT_TYPES.ACTION_CREATED,
        jobId: a.jobId,
        company: a.company,
        jobTitle: a.jobTitle,
        idempotencyKey: `action:${a.actionId}:created`,
        metadata: {
          actionId: a.actionId,
          actionType: a.type,
          mode: a.mode,
          score: a.payload.score,
          templateId: a.payload.templateId,
          messageLength: a.payload.message.length,
        },
      });
    }

    return { ok: true, created, skipped };
  });
}

// ---------------- 状态迁移 ----------------

/**
 * @param {string} actionId
 * @param {string} to
 * @param {Partial<AgentAction>} [patch]
 * @param {{eventType?: string|null, eventMetadata?: object, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
async function mutateAction(actionId, to, patch = {}, { eventType = null, eventMetadata = {}, now = new Date() } = {}) {
  return withLock(async () => {
    const list = await readActions();
    const idx = list.findIndex((a) => a.actionId === actionId);
    if (idx < 0) return { ok: false, action: null, reason: 'Action 不存在' };
    const current = list[idx];
    const guard = canTransitionAction(current.status, to);
    if (!guard.ok) return { ok: false, action: current, reason: guard.reason };

    const timestamp = now instanceof Date ? now.toISOString() : String(now);
    const next = { ...current, ...patch, status: to, updatedAt: timestamp };
    if (to === ACTION_STATUS.APPROVED) next.approvedAt = timestamp;
    if (to === ACTION_STATUS.EXECUTING) {
      next.executedAt = timestamp;
      next.attempts = (current.attempts ?? 0) + 1;
    }
    if (TERMINAL_STATUSES.includes(to)) next.finishedAt = timestamp;

    list[idx] = next;
    await writeActions(list);

    if (eventType) {
      await appendEvent({
        type: eventType,
        jobId: next.jobId,
        company: next.company,
        jobTitle: next.jobTitle,
        idempotencyKey: `action:${next.actionId}:${to}`,
        metadata: { actionId: next.actionId, actionType: next.type, status: to, ...eventMetadata },
      });
    }
    return { ok: true, action: next, reason: null };
  });
}

/**
 * 用户确认（Review）或 Policy 通过（Autopilot，Phase 3）
 * @param {string|string[]} actionIds
 * @returns {Promise<{ok: boolean, approved: AgentAction[], skipped: Array<{actionId: string, reason: string|null}>}>}
 */
export async function approveActions(actionIds, opts = {}) {
  const ids = Array.isArray(actionIds) ? actionIds : [actionIds];
  const approved = [];
  const skipped = [];
  for (const id of ids) {
    const r = await mutateAction(id, ACTION_STATUS.APPROVED, {}, { eventType: EVENT_TYPES.ACTION_APPROVED, ...opts });
    if (r.ok) approved.push(r.action);
    else skipped.push({ actionId: id, reason: r.reason });
  }
  return { ok: true, approved, skipped };
}

/**
 * @param {string} actionId
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
export async function markExecuting(actionId, opts = {}) {
  return mutateAction(actionId, ACTION_STATUS.EXECUTING, {}, opts);
}

/**
 * @param {string} actionId
 * @param {{eventId?: string|null, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
export async function markSuccess(actionId, { eventId = null, now = new Date() } = {}) {
  return mutateAction(actionId, ACTION_STATUS.SUCCESS, { eventId, lastError: null }, { now });
}

/**
 * @param {string} actionId
 * @param {{error?: string, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
export async function markFailed(actionId, { error = '未知错误', now = new Date() } = {}) {
  return mutateAction(actionId, ACTION_STATUS.FAILED, { lastError: String(error) }, { now });
}

/**
 * @param {string} actionId
 * @param {{reason?: string, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
export async function markSkipped(actionId, { reason = '跳过', now = new Date() } = {}) {
  return mutateAction(
    actionId,
    ACTION_STATUS.SKIPPED,
    { lastError: null, skipReason: String(reason) },
    { eventType: EVENT_TYPES.ACTION_SKIPPED, eventMetadata: { reason: String(reason) }, now },
  );
}

/**
 * @param {string} actionId
 * @param {{reason?: string, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, action: AgentAction|null, reason: string|null}>}
 */
export async function markRequiresManual(actionId, { reason = '需要人工处理', now = new Date() } = {}) {
  return mutateAction(
    actionId,
    ACTION_STATUS.REQUIRES_MANUAL,
    { manualReason: String(reason) },
    { eventType: EVENT_TYPES.ACTION_REQUIRES_MANUAL, eventMetadata: { reason: String(reason) }, now },
  );
}

/**
 * 恢复中断的 Action：上次运行停在 executing（Side Panel 被关掉 / 浏览器崩溃）时，
 * 无法确定消息是否已经发出 —— 保守处理为 requires_manual，绝不自动重发。
 */
/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, recovered: AgentAction[], count: number}>}
 */
export async function recoverInterruptedActions({ now = new Date() } = {}) {
  const list = await readActions();
  const interrupted = list.filter((a) => a.status === ACTION_STATUS.EXECUTING);
  const recovered = [];
  for (const a of interrupted) {
    const r = await markRequiresManual(a.actionId, {
      reason: '执行中断（Side Panel 关闭或页面刷新）：无法确认是否已发送，请人工到 BOSS 页面确认后处理',
      now,
    });
    if (r.ok) recovered.push(r.action);
  }
  return { ok: true, recovered, count: recovered.length };
}

/**
 * 清理旧 Action：保留最近 MAX_ACTIONS_KEPT 条，并删除超过保留期的终态 Action
 * @param {{retentionDays?: number, now?: Date}} [opts]
 * @returns {Promise<{ok: boolean, removed: number, kept: number}>}
 */
export async function pruneActions({ retentionDays = DEFAULT_ACTION_RETENTION_DAYS, now = new Date() } = {}) {
  return withLock(async () => {
    const list = await readActions();
    const cutoff = new Date(now.getTime() - Math.abs(retentionDays) * 86400_000).toISOString();
    const kept = list.filter((a) => {
      if (!TERMINAL_STATUSES.includes(a.status)) return true; // 未完成的绝不能删
      return (a.finishedAt ?? a.createdAt ?? '') >= cutoff;
    });
    const trimmed = kept.length > MAX_ACTIONS_KEPT ? kept.slice(-MAX_ACTIONS_KEPT) : kept;
    const removed = list.length - trimmed.length;
    await writeActions(trimmed);
    return { ok: true, removed, kept: trimmed.length };
  });
}

/** 测试/调试用 @returns {Promise<{ok: boolean}>} */
export async function clearAllActions() {
  await writeActions([]);
  return { ok: true };
}
