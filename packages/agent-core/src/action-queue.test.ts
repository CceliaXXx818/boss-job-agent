// V0.5 Phase 2：Action Queue 单元测试
// 覆盖：create / approve / execute / success / failed / 状态恢复 / 持久化 / 幂等（重复 Greeting 被阻止）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, installChrome, snapshot, restore, type ChromeStub } from './helpers/chrome-stub.js';
import {
  ACTION_STATUS,
  ACTION_TYPES,
  ACTIONS_KEY,
  approveActions,
  canTransitionAction,
  clearAllActions,
  createGreetingActions,
  getAllActions,
  getAction,
  getActions,
  getActionsForJob,
  greetingIdempotencyKey,
  isBlockingStatus,
  markExecuting,
  markFailed,
  markRequiresManual,
  markSkipped,
  markSuccess,
  pruneActions,
  recoverInterruptedActions,
  reportIdempotencyKey,
  resumeIdempotencyKey,
  summarizeActions,
} from '../../../extension/action-queue.js';
import { EVENT_TYPES, getEventsByDate, hasEvent, localDateKey } from '../../../extension/event-store.js';
import { getJobState } from '../../../extension/job-state.js';
import { recordGreetingSuccess, recordJobsDiscovered } from '../../../extension/agent-records.js';

let chromeStub: ChromeStub;

const jobs = [
  { jobId: 'j-1', title: 'AI 产品经理', company: 'A 公司', href: '/job_detail/j-1.html', score: 88 },
  { jobId: 'j-2', title: '产品经理', company: 'B 公司', href: '/job_detail/j-2.html', score: 82 },
];

const create = (list = jobs, over = {}) =>
  createGreetingActions({
    jobs: list,
    message: '你好，我想聊聊这个岗位。',
    strategy: { mode: 'template', templateId: 'default' },
    mode: 'review',
    ...over,
  });

beforeEach(() => {
  chromeStub = makeChrome();
  installChrome(chromeStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('create', () => {
  it('为每个岗位创建 pending Action，并把 message 固化进 payload', async () => {
    const r = await create();
    expect(r.created).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    const a = r.created[0];
    expect(a.status).toBe(ACTION_STATUS.PENDING);
    expect(a.type).toBe(ACTION_TYPES.GREETING);
    expect(a.payload.message).toBe('你好，我想聊聊这个岗位。');
    expect(a.payload.messageStrategy).toEqual({ mode: 'template', templateId: 'default' });
    expect(a.payload.templateId).toBe('default');
    expect(a.payload.score).toBe(88);
    expect(a.idempotencyKey).toBe('greeting:j-1');
    expect(a.lastError).toBeNull();
    expect(a.createdAt).toBeTruthy();
    expect(Object.keys(a).sort()).toEqual(
      [
        'actionId',
        'approvedAt',
        'attempts',
        'company',
        'createdAt',
        'eventId',
        'executedAt',
        'finishedAt',
        'idempotencyKey',
        'jobId',
        'jobTitle',
        'lastError',
        'mode',
        'payload',
        'status',
        'type',
        'updatedAt',
      ].sort(),
    );
  });

  it('创建时写入 ACTION_CREATED 事件（可审计）', async () => {
    await create();
    const events = await getEventsByDate(localDateKey());
    const created = events.filter((e) => e.type === EVENT_TYPES.ACTION_CREATED);
    expect(created).toHaveLength(2);
    expect(created[0].metadata.actionType).toBe(ACTION_TYPES.GREETING);
    expect(created[0].metadata.messageLength).toBeGreaterThan(0);
  });

  it('缺少 jobId 的条目被跳过', async () => {
    const r = await create([{ title: '无 id' } as unknown as (typeof jobs)[number]]);
    expect(r.created).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('缺少 jobId');
  });

  it('同一批里重复选中同一岗位只创建一个 Action', async () => {
    const r = await create([jobs[0], jobs[0]]);
    expect(r.created).toHaveLength(1);
    expect(r.skipped[0].reason).toBe('本次提交中重复选中');
  });
});

describe('approve → execute → success/failed', () => {
  it('pending → approved → executing → success 全链路', async () => {
    const { created } = await create([jobs[0]]);
    const id = created[0].actionId;

    const ap = await approveActions([id]);
    expect(ap.approved).toHaveLength(1);
    expect((await getAction(id))?.status).toBe(ACTION_STATUS.APPROVED);
    expect((await getAction(id))?.approvedAt).toBeTruthy();

    const ex = await markExecuting(id);
    expect(ex.ok).toBe(true);
    expect((await getAction(id))?.status).toBe(ACTION_STATUS.EXECUTING);
    expect((await getAction(id))?.attempts).toBe(1);
    expect((await getAction(id))?.executedAt).toBeTruthy();

    const rec = await recordGreetingSuccess({
      job: { jobId: 'j-1', title: 'AI 产品经理', company: 'A 公司' },
      message: created[0].payload.message,
      messageStrategy: created[0].payload.messageStrategy,
      templateId: created[0].payload.templateId,
      score: created[0].payload.score,
      actionId: id,
    });
    const done = await markSuccess(id, { eventId: rec.eventId });
    expect(done.ok).toBe(true);
    const final = await getAction(id);
    expect(final?.status).toBe(ACTION_STATUS.SUCCESS);
    expect(final?.eventId).toBe(rec.eventId);
    expect(final?.finishedAt).toBeTruthy();
    expect((await getJobState('j-1'))?.state).toBe('GREETED');
  });

  it('失败：executing → failed，保留 lastError，且不会变成 GREETED', async () => {
    const { created } = await create([jobs[0]]);
    const id = created[0].actionId;
    await approveActions([id]);
    await markExecuting(id);
    const r = await markFailed(id, { error: 'BOSS 页面需要人工处理（打招呼未确认发送）' });
    expect(r.ok).toBe(true);
    const a = await getAction(id);
    expect(a?.status).toBe(ACTION_STATUS.FAILED);
    expect(a?.lastError).toContain('人工处理');
    expect((await getJobState('j-1'))?.state ?? null).not.toBe('GREETED');
    expect(await hasEvent({ idempotencyKey: 'greeting:j-1' })).toBe(false);
  });

  it('非法状态迁移被拒绝（failed 不能再变 success；pending 不能直接 success）', async () => {
    const { created } = await create([jobs[0]]);
    const id = created[0].actionId;
    await approveActions([id]);
    await markExecuting(id);
    await markFailed(id, { error: 'x' });
    const r = await markSuccess(id);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('非法 Action 转移');

    const { created: c2 } = await create([jobs[1]]);
    const r2 = await markSuccess(c2[0].actionId);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('pending → success');
  });

  it('skip 与 requires_manual 路径可用', async () => {
    const { created } = await create(jobs);
    const [a1, a2] = created;
    const s = await markSkipped(a1.actionId, { reason: '已达今日上限' });
    expect(s.ok).toBe(true);
    expect((await getAction(a1.actionId))?.skipReason).toBe('已达今日上限');
    expect((await getAction(a1.actionId))?.status).toBe(ACTION_STATUS.SKIPPED);

    await approveActions([a2.actionId]);
    const m = await markRequiresManual(a2.actionId, { reason: '执行中断，需人工确认' });
    expect(m.ok).toBe(true);
    expect((await getAction(a2.actionId))?.manualReason).toContain('人工');
  });

  it('对不存在的 Action 操作返回失败而不是抛错', async () => {
    const r = await markExecuting('act_missing');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Action 不存在');
  });

  it('transition guard：终态没有出口', () => {
    expect(canTransitionAction(ACTION_STATUS.SUCCESS, ACTION_STATUS.EXECUTING).ok).toBe(false);
    expect(canTransitionAction(ACTION_STATUS.FAILED, ACTION_STATUS.SUCCESS).ok).toBe(false);
    expect(canTransitionAction(ACTION_STATUS.PENDING, ACTION_STATUS.APPROVED).ok).toBe(true);
    const bogus = (ACTION_STATUS as unknown as Record<string, string>).NOPE;
    expect(canTransitionAction(ACTION_STATUS.PENDING, bogus).ok).toBe(false);
    expect(canTransitionAction(ACTION_STATUS.EXECUTING, ACTION_STATUS.EXECUTING)).toEqual({
      ok: true,
      changed: false,
      reason: null,
    });
  });
});

describe('幂等：重复 Greeting 被阻止', () => {
  it('已有 pending Action 时不会重复创建', async () => {
    await create([jobs[0]]);
    const again = await create([jobs[0]]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0].reason).toContain('已有同类 Action（pending）');
    expect(await getAllActions()).toHaveLength(1);
  });

  it('已 success 的岗位不会重复创建（重复点击）', async () => {
    const { created } = await create([jobs[0]]);
    await approveActions([created[0].actionId]);
    await markExecuting(created[0].actionId);
    await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    await markSuccess(created[0].actionId);

    const again = await create([jobs[0]]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0].reason).toMatch(/已有同类 Action（success）|已有 GREETING_SENT 记录/);
  });

  it('只剩 GREETING_SENT 事件（无 Action）时也不会创建（如旧数据/换设备）', async () => {
    await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    const again = await create([jobs[0]]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0].reason).toBe('该岗位已有 GREETING_SENT 记录');
  });

  it('failed 之后允许重新创建 Action（重试），但成功过的不允许', async () => {
    const { created } = await create([jobs[0]]);
    await approveActions([created[0].actionId]);
    await markExecuting(created[0].actionId);
    await markFailed(created[0].actionId, { error: '页面未就绪' });

    const retry = await create([jobs[0]]);
    expect(retry.created).toHaveLength(1);
    expect(retry.created[0].idempotencyKey).toBe('greeting:j-1');
    expect(retry.created[0].actionId).not.toBe(created[0].actionId);
    expect(isBlockingStatus(ACTION_STATUS.FAILED)).toBe(false);
  });

  it('幂等键命名约定', () => {
    expect(greetingIdempotencyKey('j-1')).toBe('greeting:j-1');
    expect(resumeIdempotencyKey('j-1')).toBe('resume:j-1');
    expect(reportIdempotencyKey('2026-09-13')).toBe('report:2026-09-13');
  });
});

describe('持久化与恢复', () => {
  it('Action 存在 chrome.storage（不是内存）', async () => {
    await create(jobs);
    const stored = chromeStub.__store[ACTIONS_KEY] as unknown[];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(2);
  });

  it('重建 chrome 桩（Side Panel 关闭再打开）后队列仍可读', async () => {
    const { created } = await create([jobs[0]]);
    await approveActions([created[0].actionId]);
    const snap = snapshot(chromeStub);
    installChrome(restore(snap));

    const list = await getActions({ status: ACTION_STATUS.APPROVED });
    expect(list).toHaveLength(1);
    expect(list[0].payload.message).toBe('你好，我想聊聊这个岗位。');
    expect((await getActionsForJob('j-1'))).toHaveLength(1);
    expect(await summarizeActions()).toMatchObject({ total: 1, approved: 1, pending: 0 });
  });

  it('recoverInterruptedActions：executing 中断 → requires_manual（绝不自动重发）', async () => {
    const { created } = await create([jobs[0], jobs[1]]);
    await approveActions([created[0].actionId, created[1].actionId]);
    await markExecuting(created[0].actionId);
    await markExecuting(created[1].actionId);

    const r = await recoverInterruptedActions();
    expect(r.count).toBe(2);
    const a = await getAction(created[0].actionId);
    expect(a?.status).toBe(ACTION_STATUS.REQUIRES_MANUAL);
    expect(a?.manualReason).toContain('执行中断');
    expect(await getActions({ status: ACTION_STATUS.EXECUTING })).toHaveLength(0);
    // 中断不等于成功：不能有 GREETING_SENT
    expect(await hasEvent({ idempotencyKey: 'greeting:j-1' })).toBe(false);
  });

  it('pruneActions：保留未完成 Action，删除过期终态 Action', async () => {
    const old = new Date('2026-01-01T00:00:00');
    const { created } = await create([
      { ...jobs[0], jobId: 'old' },
      { ...jobs[1], jobId: 'live' },
    ], { now: old });
    await approveActions([created[0].actionId]);
    await markExecuting(created[0].actionId, { now: old });
    await markFailed(created[0].actionId, { error: 'x', now: old });

    const r = await pruneActions({ retentionDays: 30, now: new Date('2026-03-01T00:00:00') });
    expect(r.removed).toBe(1);
    expect((await getAction(created[0].actionId))).toBeNull(); // 过期终态被清
    expect((await getAction(created[1].actionId))).toBeTruthy(); // pending 保留
  });

  it('clearAllActions 只清 Action 队列', async () => {
    await create(jobs);
    chromeStub.__store['jobAgentEventMeta'] = { version: 1 };
    await clearAllActions();
    expect(await getAllActions()).toEqual([]);
    expect(chromeStub.__store['jobAgentEventMeta']).toBeTruthy();
  });
});

describe('Action payload 固化语义', () => {
  it('创建后修改模板不影响已创建的 Action（message 已固化）', async () => {
    const { created } = await create([jobs[0]]);
    const id = created[0].actionId;
    await approveActions([id]);
    // 模拟用户在设置里改了话术模板 —— 队列里的 message 不应变化
    chromeStub.__store['jobAgentSettings'] = { greetingStrategy: { template: '完全不同的话术' } };
    const a = await getAction(id);
    expect(a?.payload.message).toBe('你好，我想聊聊这个岗位。');
    expect(a?.payload.templateId).toBe('default');
  });

  it('GREETING_SENT 事件保存实际发送的 message 与策略', async () => {
    const { created } = await create([jobs[0]]);
    await recordGreetingSuccess({
      job: { jobId: 'j-1', title: 'AI 产品经理', company: 'A 公司' },
      message: created[0].payload.message,
      messageStrategy: created[0].payload.messageStrategy,
      templateId: created[0].payload.templateId,
      score: created[0].payload.score,
      actionId: created[0].actionId,
    });
    const events = await getEventsByDate(localDateKey());
    const sent = events.find((e) => e.type === EVENT_TYPES.GREETING_SENT);
    expect(sent?.metadata.message).toBe('你好，我想聊聊这个岗位。');
    expect(sent?.metadata.messageStrategy).toEqual({ mode: 'template', templateId: 'default' });
    expect(sent?.metadata.templateId).toBe('default');
    expect(sent?.metadata.actionId).toBe(created[0].actionId);
    expect(sent?.idempotencyKey).toBe('greeting:j-1');
  });

  it('GREETING_SENT 幂等：重复调用只写一条事件、只加一次计数', async () => {
    await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    const second = await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    expect(second.duplicate).toBe(true);
    const events = await getEventsByDate(localDateKey());
    expect(events.filter((e) => e.type === EVENT_TYPES.GREETING_SENT)).toHaveLength(1);
    expect(chromeStub.__store[`greet-${localDateKey()}`]).toBe(1);
  });
});

describe('与发现事件协同', () => {
  it('先发现再打招呼：状态链 DISCOVERED → … → GREETED 且无非法跳转', async () => {
    await recordJobsDiscovered({ jobs: [{ jobId: 'j-1', title: 'PM', company: 'A' }] });
    const { created } = await create([jobs[0]]);
    await approveActions([created[0].actionId]);
    await markExecuting(created[0].actionId);
    await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    const state = await getJobState('j-1');
    expect(state?.state).toBe('GREETED');
    expect(state?.transitions.map((t) => t.to)).toEqual([
      'DISCOVERED',
      'SCORED',
      'SHORTLISTED',
      'GREETED',
    ]);
  });
});
