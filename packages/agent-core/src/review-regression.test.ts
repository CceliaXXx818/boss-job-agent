// V0.5 Phase 2：Review Mode 回归测试
// 目的：确认接入 Event Store / Action Queue 之后，V0.4 的 Review 行为没有被削弱：
//   · 没有用户确认 → 绝不发送
//   · 同一个岗位不会重复发送（重复点击 / 刷新 / 重开 Side Panel）
//   · 失败不会误标 GREETED
//   · V0.4 的 greetedHistory / greet-YYYY-MM-DD 继续兼容
// 同时包含对 sidepanel.js 的结构性断言（防止未来把发送逻辑挪出"用户确认"之后）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChrome, installChrome, snapshot, restore, type ChromeStub } from './helpers/chrome-stub.js';
import {
  ACTION_STATUS,
  approveActions,
  createGreetingActions,
  getActions,
  markExecuting,
  markFailed,
  markSkipped,
  markSuccess,
  recoverInterruptedActions,
} from '../../../extension/action-queue.js';
import { EVENT_TYPES, getEventsByDate, hasEvent, localDateKey, utcDateKey } from '../../../extension/event-store.js';
import { getJobState } from '../../../extension/job-state.js';
import {
  getDailyGreetingCount,
  getGreetedHistory,
  hasGreeted,
  recordGreetingFailure,
  recordGreetingSuccess,
} from '../../../extension/agent-records.js';
import { canGreet } from '../../../extension/core-logic.js';

let chromeStub: ChromeStub;

const job = { jobId: 'j-1', title: 'AI 产品经理', company: 'A 公司', href: '/job_detail/j-1.html', score: 88 };
const MESSAGE = '你好，我有 5 年产品经验，希望进一步交流。';

/** 安装新的 chrome 桩并同步测试句柄（避免断言读到旧 store） */
function useChrome(initial: Record<string, unknown> = {}) {
  chromeStub = makeChrome(initial);
  installChrome(chromeStub);
  return chromeStub;
}

const stage = (list = [job]) =>
  createGreetingActions({
    jobs: list,
    message: MESSAGE,
    strategy: { mode: 'template', templateId: 'default' },
    mode: 'review',
  });

/** 模拟 sidepanel.executeStagedActions 里"执行前最终闸门 + 成功/失败记账"这段逻辑 */
async function execute(actionId: string, { fail = false, dailyDone = 0, dailyCap = 5 } = {}) {
  if (await hasGreeted(job.jobId)) {
    await markSkipped(actionId, { reason: '该岗位已有 GREETING_SENT 记录' });
    return { status: ACTION_STATUS.SKIPPED, reason: 'duplicate' };
  }
  const history = await getGreetedHistory();
  const gate = canGreet({ approved: true, dailyDone, dailyCap, jobId: job.jobId, history });
  if (!gate.ok) {
    await markSkipped(actionId, { reason: gate.reason });
    return { status: ACTION_STATUS.SKIPPED, reason: gate.reason };
  }
  await markExecuting(actionId);
  if (fail) {
    await recordGreetingFailure({ job, error: 'BOSS 页面需要人工处理', actionId });
    await markFailed(actionId, { error: 'BOSS 页面需要人工处理' });
    return { status: ACTION_STATUS.FAILED, reason: null };
  }
  const rec = await recordGreetingSuccess({ job, message: MESSAGE, templateId: 'default', score: job.score, actionId });
  await markSuccess(actionId, { eventId: rec.eventId });
  return { status: ACTION_STATUS.SUCCESS, reason: null };
}

beforeEach(() => {
  chromeStub = makeChrome();
  installChrome(chromeStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('未确认不能发送', () => {
  it('只创建 Action（pending）不会有任何 GREETING_SENT', async () => {
    const { created } = await stage();
    expect(created[0].status).toBe(ACTION_STATUS.PENDING);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(false);
    expect(await getJobState(job.jobId)).toBeNull();
    expect((await getDailyGreetingCount()).effective).toBe(0);
  });

  it('用户在二次确认里取消 → Action 标记 skipped，仍然没有发送', async () => {
    const { created } = await stage();
    await markSkipped(created[0].actionId, { reason: '用户在二次确认时取消' });
    const a = (await getActions())[0];
    expect(a.status).toBe(ACTION_STATUS.SKIPPED);
    expect(a.skipReason).toContain('取消');
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(false);
  });

  it('未批准的 Action 不能被标记为执行成功（必须先 approved）', async () => {
    const { created } = await stage();
    await markExecuting(created[0].actionId).then(async (r) => {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('pending → executing');
    });
  });
});

describe('确认后正常发送（V0.4 体验不变）', () => {
  it('approved → executing → success，且事件与状态一致', async () => {
    const { created } = await stage();
    await approveActions([created[0].actionId]);
    const out = await execute(created[0].actionId);
    expect(out.status).toBe(ACTION_STATUS.SUCCESS);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId: job.jobId })).toBe(true);
    expect((await getJobState(job.jobId))?.state).toBe('GREETED');
    expect((await getDailyGreetingCount()).effective).toBe(1);
    expect([...(await getGreetedHistory())]).toContain(job.jobId);
  });

  it('失败时给用户明确结果，且不写 GREETING_SENT / 不置 GREETED', async () => {
    const { created } = await stage();
    await approveActions([created[0].actionId]);
    const out = await execute(created[0].actionId, { fail: true });
    expect(out.status).toBe(ACTION_STATUS.FAILED);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(false);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_FAILED, jobId: job.jobId })).toBe(true);
    expect((await getJobState(job.jobId))?.state ?? null).not.toBe('GREETED');
    expect((await getActions())[0].lastError).toContain('人工处理');
  });
});

describe('同一岗位不会重复发送', () => {
  it('重复点击：第二次创建被队列拦住', async () => {
    const first = await stage();
    await approveActions([first.created[0].actionId]);
    await execute(first.created[0].actionId);

    const second = await stage();
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });

  it('页面刷新 / Side Panel 重开：队列与事件都还在，重开后仍拦得住', async () => {
    const first = await stage();
    await approveActions([first.created[0].actionId]);
    await execute(first.created[0].actionId);

    const snap = snapshot(chromeStub);
    installChrome(restore(snap)); // 模拟重开

    expect(await hasGreeted(job.jobId)).toBe(true);
    const again = await stage();
    expect(again.created).toHaveLength(0);

    // 即使有人绕过创建、直接执行一个伪造的 Action，最终闸门仍会拦住
    const forged = { actionId: 'act_forged', jobId: job.jobId };
    await chromeStub.storage.local.set({
      jobAgentActions: [
        {
          actionId: forged.actionId,
          type: 'GREETING',
          jobId: job.jobId,
          status: ACTION_STATUS.APPROVED,
          payload: { message: MESSAGE, messageStrategy: { mode: 'template', templateId: 'default' } },
          idempotencyKey: 'greeting:j-1',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const out = await execute(forged.actionId);
    expect(out.status).toBe(ACTION_STATUS.SKIPPED);
    expect(await getEventsByDate(localDateKey()).then((e) => e.filter((x) => x.type === EVENT_TYPES.GREETING_SENT))).toHaveLength(1);
  });

  it('中断的 Action 重开后变成 requires_manual，不会被当成成功也不会自动重发', async () => {
    const first = await stage();
    await approveActions([first.created[0].actionId]);
    await markExecuting(first.created[0].actionId);

    const snap = snapshot(chromeStub);
    installChrome(restore(snap));

    const r = await recoverInterruptedActions();
    expect(r.count).toBe(1);
    expect((await getActions())[0].status).toBe(ACTION_STATUS.REQUIRES_MANUAL);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(false);
    expect(await getJobState(job.jobId)).toBeNull();
  });

  it('每日上限仍然生效（默认 5，达上限则跳过而不发送）', async () => {
    const { created } = await stage();
    await approveActions([created[0].actionId]);
    const out = await execute(created[0].actionId, { dailyDone: 5, dailyCap: 5 });
    expect(out.status).toBe(ACTION_STATUS.SKIPPED);
    expect(out.reason).toContain('已达今日上限');
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(false);
  });
});

describe('Legacy 存储兼容（read-old / write-new）', () => {
  it('旧 greetedHistory 继续被读取，并在创建阶段就拦住', async () => {
    useChrome({ greetedHistory: [job.jobId] });
    expect((await getGreetedHistory()).has(job.jobId)).toBe(true);
    expect(await hasGreeted(job.jobId)).toBe(true);
    const r = await stage();
    expect(r.created).toHaveLength(0); // 旧历史里已联系过 → 不再创建
    expect(r.skipped[0].reason).toContain('greetedHistory');
  });

  it('旧 greet-YYYY-MM-DD 计数被计入每日上限', async () => {
    const local = localDateKey();
    useChrome({ [`greet-${local}`]: 4 });
    const daily = await getDailyGreetingCount();
    expect(daily.legacyLocal).toBe(4);
    expect(daily.effective).toBe(4);
  });

  it('新行为同时写 Event Store 与 legacy key（降级回 V0.4 也不会超发）', async () => {
    await recordGreetingSuccess({ job, message: MESSAGE, templateId: 'default' });
    const local = localDateKey();
    const utc = utcDateKey();
    expect(chromeStub.__store[`greet-${local}`]).toBe(1);
    if (utc !== local) expect(chromeStub.__store[`greet-${utc}`]).toBe(1);
    expect(chromeStub.__store['greetedHistory']).toEqual([job.jobId]);
    expect((await getEventsByDate(local)).filter((e) => e.type === EVENT_TYPES.GREETING_SENT)).toHaveLength(1);
  });

  it('legacy 与事件并存时不会少算（旧 3 条 + 新 1 条 = 4）', async () => {
    const local = localDateKey();
    useChrome({ [`greet-${local}`]: 3 });
    await recordGreetingSuccess({ job, message: MESSAGE });
    const daily = await getDailyGreetingCount();
    expect(daily.legacyLocal).toBe(4); // 旧计数被 +1（继续兼容写）
    expect(daily.events).toBe(1); // 事件里只有本次这一条
    expect(daily.effective).toBe(4); // 取最大值：不会因为只看事件而少算
  });

  it('旧 key 不会被删除', async () => {
    const local = localDateKey();
    useChrome({ [`greet-${local}`]: 2, greetedHistory: ['old-job'] });
    await recordGreetingSuccess({ job, message: MESSAGE });
    expect(chromeStub.__store[`greet-${local}`]).toBe(3);
    expect(chromeStub.__store['greetedHistory']).toEqual(['old-job', job.jobId]);
  });
});

describe('sidepanel.js 结构性断言（防止未来回归）', () => {
  const src = readFileSync(join(process.cwd(), 'extension', 'sidepanel.js'), 'utf8');
  const slice = (from: string, to: string) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to);
    expect(a, `未找到 ${from}`).toBeGreaterThan(-1);
    return src.slice(a, b > a ? b : undefined);
  };

  it('greetFull 只在 executeStagedActions 内出现（发送路径唯一）', () => {
    const occurrences = src.split("type: 'greetFull'").length - 1;
    expect(occurrences).toBe(1);
    const body = slice('async function executeStagedActions()', 'export async function renderAgentStatePanel');
    expect(body).toContain("type: 'greetFull'");
  });

  it('approveActions 只在用户确认之后调用（先 approved，再执行）', () => {
    const body = slice('async function executeStagedActions()', 'export async function renderAgentStatePanel');
    expect(body.indexOf('await approveActions(')).toBeLessThan(body.indexOf("type: 'greetFull'"));
  });

  it('成功路径调用 recordGreetingSuccess，失败路径调用 recordGreetingFailure', () => {
    const body = slice('async function executeStagedActions()', 'export async function renderAgentStatePanel');
    expect(body).toContain('await recordGreetingSuccess(');
    expect(body).toContain('recordGreetingFailure(');
    expect(body).toContain('await markFailed(');
  });

  it('队列与状态面板从 storage 读取（不依赖内存变量）', () => {
    const body = slice('export async function renderAgentStatePanel()', 'let refreshTimer');
    expect(body).toContain('summarizeActions()');
    expect(body).toContain('countByState()');
    expect(body).toContain('getEventMeta()');
    expect(body).toContain('aggregateEvents(');
  });

  it('启动时恢复中断 Action（绝不自动重发）', () => {
    const body = slice('async function init()', 'export {');
    expect(body).toContain('recoverInterruptedActions()');
  });
});
