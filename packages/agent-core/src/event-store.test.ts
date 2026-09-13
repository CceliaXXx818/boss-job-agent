// V0.5 Phase 2：Event Store 单元测试
// 覆盖：append / 幂等 / 按日期 / 按 Job / 聚合 / retention prune / 分区结构 / 并发 append
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, installChrome, snapshot, restore, type ChromeStub } from './helpers/chrome-stub.js';
import {
  EVENT_TYPES,
  EVENT_PREFIX,
  META_KEY,
  IDEMPOTENCY_KEY,
  appendEvent,
  appendEvents,
  aggregateEvents,
  clearAllEvents,
  getEventDates,
  getEventMeta,
  getEventsByDate,
  getEventsByJob,
  hasEvent,
  localDateKey,
  pruneEvents,
  shiftDateKey,
  utcDateKey,
} from '../../../extension/event-store.js';

let chromeStub: ChromeStub;

const greet = (jobId: string, over: Record<string, unknown> = {}) => ({
  type: EVENT_TYPES.GREETING_SENT,
  jobId,
  company: '某公司',
  jobTitle: 'AI 产品经理',
  idempotencyKey: `greeting:${jobId}`,
  metadata: { message: '你好', templateId: 'default' },
  ...over,
});

beforeEach(() => {
  chromeStub = makeChrome();
  installChrome(chromeStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appendEvent', () => {
  it('写入成功并返回完整事件（8 个基础字段齐全）', async () => {
    const r = await appendEvent(greet('j-1'));
    expect(r.ok).toBe(true);
    expect(r.appended).toBe(true);
    expect(r.duplicate).toBe(false);
    expect(Object.keys(r.event).sort()).toEqual(
      ['company', 'eventId', 'idempotencyKey', 'jobId', 'jobTitle', 'metadata', 'timestamp', 'type'].sort(),
    );
    expect(r.event.eventId).toMatch(/^evt_/);
    expect(r.event.jobId).toBe('j-1');
  });

  it('缺少 type 直接抛错（不允许写入无法识别的事件）', async () => {
    await expect(appendEvent({ jobId: 'j-1' } as unknown as { type: string })).rejects.toThrow(/type 必填/);
  });

  it('相同 idempotencyKey 第二次不会重复写入', async () => {
    const a = await appendEvent(greet('j-1'));
    const b = await appendEvent(greet('j-1'));
    expect(a.appended).toBe(true);
    expect(b.appended).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.event.eventId).toBe(a.event.eventId);
    expect(await getEventsByDate(localDateKey())).toHaveLength(1);
    expect((await getEventMeta()).totalEvents).toBe(1);
  });

  it('没有 idempotencyKey 的事件每次都写入（如控制面事件）', async () => {
    await appendEvent({ type: EVENT_TYPES.MODE_CHANGED, metadata: { mode: 'review' } });
    await appendEvent({ type: EVENT_TYPES.MODE_CHANGED, metadata: { mode: 'autopilot' } });
    expect((await getEventMeta()).totalEvents).toBe(2);
  });

  it('metadata 只保留可 JSON 化数据（禁止塞入 live 对象）', async () => {
    const fn = () => 1;
    const r = await appendEvent({ type: EVENT_TYPES.SETTINGS_UPDATED, metadata: { fn, ok: true } });
    expect(r.event.metadata).toEqual({ ok: true });
  });

  it('并发 append 不会互相覆盖（写锁生效）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_v, i) => appendEvent({ type: EVENT_TYPES.JOB_SCORED, jobId: `j-${i}`, idempotencyKey: `scored:j-${i}` })),
    );
    const events = await getEventsByDate(localDateKey());
    expect(events).toHaveLength(20);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(20);
  });

  it('appendEvents 批量写入：一次调用写入多条且各自幂等', async () => {
    const r = await appendEvents([
      { type: EVENT_TYPES.JOB_DISCOVERED, jobId: 'a', idempotencyKey: 'discovered:a' },
      { type: EVENT_TYPES.JOB_DISCOVERED, jobId: 'b', idempotencyKey: 'discovered:b' },
    ]);
    expect(r.appended).toBe(2);
    const again = await appendEvents([
      { type: EVENT_TYPES.JOB_DISCOVERED, jobId: 'a', idempotencyKey: 'discovered:a' },
      { type: EVENT_TYPES.JOB_DISCOVERED, jobId: 'c', idempotencyKey: 'discovered:c' },
    ]);
    expect(again.appended).toBe(1);
    expect(again.duplicates).toBe(1);
    expect((await getEventMeta()).totalEvents).toBe(3);
  });
});

describe('读取接口', () => {
  it('按日期查询', async () => {
    const day1 = new Date('2026-03-01T10:00:00');
    const day2 = new Date('2026-03-02T10:00:00');
    await appendEvent(greet('j-1'), { now: day1 });
    await appendEvent(greet('j-2'), { now: day2 });
    expect(await getEventsByDate(localDateKey(day1))).toHaveLength(1);
    expect(await getEventsByDate('2026-01-01')).toEqual([]);
    expect(await getEventsByDate('bad-date')).toEqual([]);
    expect(await getEventDates()).toEqual([localDateKey(day1), localDateKey(day2)].sort());
  });

  it('按 Job 查询（跨日期，时间升序）', async () => {
    await appendEvent(greet('j-1'), { now: new Date('2026-03-01T10:00:00') });
    await appendEvent({ type: EVENT_TYPES.JOB_SHORTLISTED, jobId: 'j-1', idempotencyKey: 'shortlisted:j-1:2026-03-01' }, {
      now: new Date('2026-03-02T10:00:00'),
    });
    await appendEvent(greet('j-2'));
    const list = await getEventsByJob('j-1');
    expect(list.map((e) => e.type)).toEqual([EVENT_TYPES.GREETING_SENT, EVENT_TYPES.JOB_SHORTLISTED]);
    expect(await getEventsByJob('nobody')).toEqual([]);
    expect(await getEventsByJob(null)).toEqual([]);
  });

  it('hasEvent：幂等键命中，且校验 type/jobId 一致性', async () => {
    await appendEvent(greet('j-1'));
    expect(await hasEvent({ idempotencyKey: 'greeting:j-1' })).toBe(true);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId: 'j-1', idempotencyKey: 'greeting:j-1' })).toBe(true);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId: 'j-2', idempotencyKey: 'greeting:j-1' })).toBe(false);
    expect(await hasEvent({ type: EVENT_TYPES.RESUME_SENT, idempotencyKey: 'greeting:j-1' })).toBe(false);
    expect(await hasEvent({ idempotencyKey: 'greeting:none' })).toBe(false);
  });

  it('hasEvent：只给 type 时扫描分区', async () => {
    await appendEvent(greet('j-1'));
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT })).toBe(true);
    expect(await hasEvent({ type: EVENT_TYPES.GREETING_SENT, jobId: 'j-9' })).toBe(false);
    expect(await hasEvent({ type: EVENT_TYPES.RESUME_SENT })).toBe(false);
    expect(await hasEvent({})).toBe(false);
  });

  it('aggregateEvents 区间聚合（含日计数与常用口径）', async () => {
    const d1 = new Date('2026-03-01T10:00:00');
    const d2 = new Date('2026-03-02T10:00:00');
    const d3 = new Date('2026-03-03T10:00:00');
    await appendEvent({ type: EVENT_TYPES.JOB_DISCOVERED, jobId: 'a', idempotencyKey: 'discovered:a' }, { now: d1 });
    await appendEvent({ type: EVENT_TYPES.JOB_SCORED, jobId: 'a', idempotencyKey: 'scored:a' }, { now: d1 });
    await appendEvent(greet('a'), { now: d2 });
    await appendEvent(greet('b'), { now: d3 });

    const key1 = String(localDateKey(d1));
    const key2 = String(localDateKey(d2));
    const mid = await aggregateEvents({ startDate: key1, endDate: key2 });
    expect(mid.total).toBe(3);
    expect(mid.discovered).toBe(1);
    expect(mid.scored).toBe(1);
    expect(mid.greetingSent).toBe(1);
    expect(mid.byDate[key1]).toBe(2);

    const all = await aggregateEvents({});
    expect(all.total).toBe(4);
    expect(all.greetingSent).toBe(2);
    expect(all.startDate).toBe(key1);
    expect(all.endDate).toBe(String(localDateKey(d3)));
  });
});

describe('存储结构与 retention', () => {
  it('按日期分区，不是单个数组', async () => {
    await appendEvent(greet('j-1'), { now: new Date('2026-03-01T10:00:00') });
    await appendEvent(greet('j-2'), { now: new Date('2026-03-02T10:00:00') });
    const keys = Object.keys(chromeStub.__store);
    expect(keys).toContain(`${EVENT_PREFIX}2026-03-01`);
    expect(keys).toContain(`${EVENT_PREFIX}2026-03-02`);
    expect(keys).toContain(META_KEY);
    expect(keys).toContain(IDEMPOTENCY_KEY);
    expect(Array.isArray(chromeStub.__store[`${EVENT_PREFIX}2026-03-01`])).toBe(true);
  });

  it('pruneEvents 删除超过保留期的分区，但保留副作用幂等键', async () => {
    const old = new Date('2026-01-01T10:00:00');
    const recent = new Date('2026-03-01T10:00:00');
    await appendEvent(greet('old-job'), { now: old });
    await appendEvent({ type: EVENT_TYPES.JOB_SCORED, jobId: 'old-job', idempotencyKey: 'scored:old-job' }, { now: old });
    await appendEvent(greet('new-job'), { now: recent });

    const r = await pruneEvents({ retentionDays: 30, now: new Date('2026-03-02T10:00:00') });
    expect(r.removedDates).toEqual(['2026-01-01']);
    expect(r.removedEvents).toBe(2);
    expect(await getEventsByDate('2026-01-01')).toEqual([]); // 分区已删
    expect(await getEventsByDate('2026-03-01')).toHaveLength(1); // 近期保留
    expect(r.keptCriticalKeys).toBe(1); // GREETING_SENT 的键保留

    // 关键：即使事件被清理，"这个岗位已打过招呼"依然成立 → 不会被重复打招呼
    expect(await hasEvent({ idempotencyKey: 'greeting:old-job' })).toBe(true);
    expect(await hasEvent({ idempotencyKey: 'scored:old-job' })).toBe(false);
  });

  it('pruneEvents 写入 meta（retentionDays / lastPrunedAt / totalEvents 重算）', async () => {
    await appendEvent(greet('j-1'));
    const r = await pruneEvents({ retentionDays: 7, now: new Date() });
    const meta = await getEventMeta();
    expect(meta.retentionDays).toBe(7);
    expect(meta.lastPrunedAt).toBeTruthy();
    expect(meta.totalEvents).toBe(1);
    expect(r.cutoff).toBe(shiftDateKey(localDateKey(new Date()), -7));
  });

  it('无过期数据时 prune 是安全的空操作', async () => {
    await appendEvent(greet('j-1'));
    const r = await pruneEvents({ retentionDays: 30, now: new Date() });
    expect(r.removedDates).toEqual([]);
    expect((await getEventMeta()).totalEvents).toBe(1);
  });

  it('dateKey 工具：本地键与 UTC 键、日期偏移', () => {
    expect(localDateKey(new Date('2026-03-01T10:00:00'))).toBe('2026-03-01');
    expect(utcDateKey(new Date('2026-03-01T10:00:00'))).toBe('2026-03-01');
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('持久化：重建 chrome 桩后事件与幂等索引仍在（可被 background SW 读取）', async () => {
    await appendEvent(greet('j-1'));
    const snap = snapshot(chromeStub);
    installChrome(restore(snap));
    expect(await getEventsByJob('j-1')).toHaveLength(1);
    expect(await hasEvent({ idempotencyKey: 'greeting:j-1' })).toBe(true);
    const again = await appendEvent(greet('j-1'));
    expect(again.appended).toBe(false); // 重开后依然幂等
  });

  it('clearAllEvents 只清事件，不碰其它 key', async () => {
    await appendEvent(greet('j-1'));
    chromeStub.__store['jobAgentActions'] = [{ actionId: 'x' }];
    await clearAllEvents();
    expect(await getEventDates()).toEqual([]);
    expect(chromeStub.__store['jobAgentActions']).toEqual([{ actionId: 'x' }]);
  });
});
