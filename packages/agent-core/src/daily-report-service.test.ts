// V0.5 Phase 4：日报服务层测试（snapshot 幂等 / 18:00 alarm / catch-up / 只读不污染）
// 对应规格 §17 catch-up、§19 snapshot、§20 幂等、§33 正式日报幂等、§34 补生成、§38 不污染执行状态
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, installChrome, type ChromeStub } from './helpers/chrome-stub.js';
import { autopilotSettings } from './helpers/autopilot-harness.js';
import {
  REPORT_ALARM,
  SNAPSHOT_PREFIX,
  catchUpIfNeeded,
  deleteSnapshot,
  ensureDailyReportAlarm,
  generateDailyReportOnce,
  getSnapshot,
  listSnapshots,
  nextReportFireTime,
  previewDailyReport,
  shouldCatchUp,
  snapshotKey,
} from '../../../extension/daily-report-service.js';
import { EVENT_TYPES, appendEvent, getEventMeta, getEventsByDate, hasEvent, localDateKey } from '../../../extension/event-store.js';
import { getAllActions, ACTIONS_KEY } from '../../../extension/action-queue.js';
import { getAllJobStates, JOB_STATES_KEY } from '../../../extension/job-state.js';
import { RUNTIME_KEY, loadRuntime, patchRuntime } from '../../../extension/autopilot-runtime.js';

let chromeStub: ChromeStub;
let alarms: Array<{ name: string; when?: number }>;
let cleared: string[];

const DAY = '2026-09-13';
const at = (hhmm: string, ss = '00') => new Date(`2026-09-13T${hhmm}:${ss}`).toISOString();
const localAt = (hhmm: string) => new Date(`2026-09-13T${hhmm}:00`);

function installChromeWithAlarms(initial: Record<string, unknown> = {}) {
  chromeStub = makeChrome(initial);
  installChrome(chromeStub);
  (globalThis as any).chrome.alarms = {
    create: (name: string, info: { when?: number }) => {
      alarms.push({ name, when: info?.when });
    },
    get: async () => null,
    clear: async (name: string) => {
      cleared.push(name);
      return true;
    },
    onAlarm: { addListener() {} },
  };
  return chromeStub;
}

/** 造一天的事件（含一次 Autopilot 会话） */
async function seedDay({ cap = 2, contacted = 2, rounds = 1 } = {}) {
  await appendEvent({ type: EVENT_TYPES.AUTOPILOT_STARTED, timestamp: at('09:00'), jobId: null, idempotencyKey: 'ap-start', metadata: { sessionId: 'ap_1', dailyGreetingCap: cap, todayGreetingCount: 0, city: '上海' } });
  for (let i = 1; i <= rounds; i++) {
    await appendEvent({
      type: EVENT_TYPES.DISCOVERY_ROUND_COMPLETED,
      timestamp: at(`10:0${i}`),
      jobId: null,
      idempotencyKey: `round-completed:ap_1:${i}`,
      metadata: { roundIndex: i, searchedQueries: [`词${i}`], discoveredCount: 10 * i, filteredCount: 5, analyzedCount: 5, recommendedCount: 3, eligibleCount: 2, roundTarget: 2, replanCount: 0, city: '上海' },
    });
  }
  for (let i = 1; i <= contacted; i++) {
    await appendEvent({
      type: EVENT_TYPES.GREETING_SENT,
      timestamp: at('20:38', String(i).padStart(2, '0')),
      jobId: `job-${i}`,
      jobTitle: `岗位${i}`,
      company: '某公司',
      idempotencyKey: `greeting:job-${i}`,
      metadata: { mode: 'autopilot', score: 90, href: `/job_detail/job-${i}.html`, messageStrategy: { mode: 'template', templateId: 'default' } },
    });
  }
  await appendEvent({
    type: EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE,
    timestamp: at('20:39'),
    jobId: null,
    idempotencyKey: 'outreach-complete:ap_1',
    metadata: { sessionId: 'ap_1', reason: '已达今日上限', code: 'DAILY_CAP_REACHED', todayGreetingCount: contacted },
  });
}

beforeEach(() => {
  alarms = [];
  cleared = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('§18 预览不写任何东西', () => {
  it('previewDailyReport 只读：不产生事件 / snapshot / 状态变化', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    const before = { events: (await getEventsByDate(DAY)).length, meta: await getEventMeta(), keys: Object.keys(chromeStub.__store).sort() };

    const report = await previewDailyReport({ date: DAY, now: localAt('21:00') });

    expect(report.summary.contacted).toBe(2);
    expect(report.generatedAt).toBeNull();
    expect(await getSnapshot(DAY)).toBeNull();
    expect(await hasEvent({ type: EVENT_TYPES.DAILY_REPORT_GENERATED })).toBe(false);
    expect((await getEventsByDate(DAY)).length).toBe(before.events);
    expect(Object.keys(chromeStub.__store).sort()).toEqual(before.keys);
  });
});

describe('§19 / §20 正式日报：snapshot + 幂等', () => {
  it('首次生成：写 snapshot + DAILY_REPORT_GENERATED（幂等键 report:<date>）', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    const res = await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });

    expect(res.created).toBe(true);
    expect(res.source).toBe('generated');
    expect(res.snapshot).toMatchObject({ date: DAY, version: 1 });
    expect(res.snapshot.report.outreach).toMatchObject({ dailyCap: 2, contacted: 2, goalReached: true, stopReason: 'DAILY_CAP_REACHED' });
    expect(chromeStub.__store[snapshotKey(DAY)]).toBeTruthy();

    const ev = (await getEventsByDate(DAY)).filter((e) => e.type === EVENT_TYPES.DAILY_REPORT_GENERATED);
    expect(ev).toHaveLength(1);
    expect(ev[0].idempotencyKey).toBe(`report:${DAY}`);
    expect((ev[0].metadata as { summary: { contacted: number } }).summary.contacted).toBe(2);
  });

  it('§33 第二次调用 / alarm 重复 / SW 重启 都不会重复生成', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    const firstSnapshot = await getSnapshot(DAY);

    const second = await generateDailyReportOnce({ date: DAY, now: localAt('18:05') });
    expect(second.created).toBe(false);
    expect(second.source).toBe('snapshot');
    expect((await getSnapshot(DAY))?.generatedAt).toBe(firstSnapshot?.generatedAt);

    // 模拟 SW 重启：重建 storage 桩后再次触发
    const snap = JSON.parse(JSON.stringify(chromeStub.__store));
    installChromeWithAlarms(snap);
    const third = await generateDailyReportOnce({ date: DAY, now: localAt('19:00') });
    expect(third.created).toBe(false);
    expect((await getEventsByDate(DAY)).filter((e) => e.type === EVENT_TYPES.DAILY_REPORT_GENERATED)).toHaveLength(1);
  });

  it('事件已存在但 snapshot 丢失 → 补写 snapshot，不重复写事件', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    await deleteSnapshot(DAY);
    expect(await getSnapshot(DAY)).toBeNull();

    const res = await generateDailyReportOnce({ date: DAY, now: localAt('18:30') });
    expect(res.created).toBe(true);
    expect(res.source).toBe('snapshot-recreated');
    expect(res.duplicateEvent).toBe(true);
    expect((await getEventsByDate(DAY)).filter((e) => e.type === EVENT_TYPES.DAILY_REPORT_GENERATED)).toHaveLength(1);
  });

  it('listSnapshots 只列出日报快照', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    expect(await listSnapshots()).toEqual([DAY]);
    expect(Object.keys(chromeStub.__store).some((k) => k.startsWith(SNAPSHOT_PREFIX))).toBe(true);
  });
});

describe('§34 Catch-up', () => {
  it('18:00 前不补生成；18:00 后且未生成 → 补生成一次', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2, dailyReportTime: '18:00' }) });
    await seedDay();

    const early = await shouldCatchUp({ now: localAt('17:59') });
    expect(early).toMatchObject({ needed: false, reason: 'BEFORE_REPORT_TIME' });

    const due = await shouldCatchUp({ now: localAt('20:00') });
    expect(due).toMatchObject({ needed: true, reason: 'CATCH_UP', date: localDateKey(localAt('20:00')) });

    // 注意：seedDay 写的是固定日期 DAY 的事件；这里用 DAY 作为"今天"来补生成
    const res = await catchUpIfNeeded({ now: new Date('2026-09-13T20:00:00') });
    expect(res.generated).toBe(true);
    expect(await getSnapshot(localDateKey(new Date('2026-09-13T20:00:00')))).toBeTruthy();
  });

  it('已生成 → 不再补生成', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    const now = new Date('2026-09-13T20:00:00');
    await catchUpIfNeeded({ now });
    const again = await catchUpIfNeeded({ now: new Date('2026-09-13T21:00:00') });
    expect(again.generated).toBe(false);
    expect(again.reason).toBe('SNAPSHOT_EXISTS');
  });

  it('日报开关关闭 → 既不补生成也不排期', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyReportEnabled: false }) });
    expect(await shouldCatchUp({ now: localAt('20:00') })).toMatchObject({ needed: false, reason: 'DISABLED' });
    const alarm = await ensureDailyReportAlarm({ now: localAt('10:00') });
    expect(alarm).toMatchObject({ ok: true, scheduled: false });
    expect(cleared).toContain(REPORT_ALARM);
  });

  it('§35 今天没有任何活动也能生成（不报错，明确写无活动）', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    const res = await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    expect(res.created).toBe(true);
    expect(res.snapshot.report.hasActivity).toBe(false);
    expect(res.snapshot.report.outreach.stopReason).toBe('NO_SESSION');
    expect(res.snapshot.report.summary.discovered).toBe(0);
  });
});

describe('§16 18:00 alarm（一次性 alarm，不用长驻 timer）', () => {
  it('今天还没到点 → 排到今天；已过点 → 排到明天', () => {
    const morning = localAt('10:00');
    expect(nextReportFireTime(morning, '18:00')).toBe(new Date('2026-09-13T18:00:00').getTime());
    const evening = localAt('20:00');
    expect(nextReportFireTime(evening, '18:00')).toBe(new Date('2026-09-14T18:00:00').getTime());
  });

  it('ensureDailyReportAlarm 使用 settings.dailyReportTime 并写入一次 alarm', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyReportTime: '19:30' }) });
    const res = await ensureDailyReportAlarm({ now: localAt('10:00') });
    expect(res.scheduled).toBe(true);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].name).toBe(REPORT_ALARM);
    expect(alarms[0].when).toBe(new Date('2026-09-13T19:30:00').getTime());
  });

  it('不使用 setInterval / 长驻 timer（源码约束）', async () => {
    const src = await import('node:fs').then(async (fs) => ({
      bg: fs.readFileSync('extension/background.js', 'utf8'),
      svc: fs.readFileSync('extension/daily-report-service.js', 'utf8'),
    }));
    const strip = (code: string) =>
      code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
    for (const code of [src.bg, src.svc]) {
      expect(strip(code)).not.toMatch(/setInterval/);
      expect(strip(code)).not.toMatch(/while\s*\(\s*true/);
    }
    expect(src.bg).toMatch(/chrome\.alarms\.onAlarm\.addListener/);
    expect(src.bg).toContain('dailyReport.REPORT_ALARM');
  });
});

describe('§38 日报不污染执行状态', () => {
  it('生成日报不改 Job State / Action Queue / Daily Cap / Runtime', async () => {
    installChromeWithAlarms({
      jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }),
      [JOB_STATES_KEY]: { 'job-1': { jobId: 'job-1', state: 'GREETED', updatedAt: at('20:38') } },
      [ACTIONS_KEY]: [{ actionId: 'act_1', type: 'GREETING', jobId: 'job-1', status: 'success' }],
    });
    await seedDay();
    await patchRuntime((r) => ({ ...r, status: 'MONITORING', sessionId: 'ap_1', todayGreetingCount: 2, log: [{ at: at('09:00'), text: 'x' }] }));

    const statesBefore = await getAllJobStates();
    const actionsBefore = await getAllActions();
    const runtimeBefore = await loadRuntime();
    const settingsBefore = JSON.stringify(chromeStub.__store['jobAgentSettings']);

    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    await catchUpIfNeeded({ now: localAt('20:00') });

    expect(await getAllJobStates()).toEqual(statesBefore);
    expect(await getAllActions()).toEqual(actionsBefore);
    expect(await loadRuntime()).toEqual(runtimeBefore);
    expect(JSON.stringify(chromeStub.__store['jobAgentSettings'])).toBe(settingsBefore);
    // 只允许新增 snapshot 与一条日报事件
    expect((await getEventsByDate(DAY)).filter((e) => e.type === EVENT_TYPES.DAILY_REPORT_GENERATED)).toHaveLength(1);
  });

  it('生成日报不改 runtime 的 status（MONITORING 仍是 MONITORING）', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings() });
    await seedDay();
    await patchRuntime((r) => ({ ...r, status: 'MONITORING' }));
    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    expect((await loadRuntime()).status).toBe('MONITORING');
  });
});

describe('§39 性能：只读当天分区', () => {
  it('生成某天日报不会读取或改写其它日期的分区', async () => {
    installChromeWithAlarms({ jobAgentSettings: autopilotSettings({ dailyGreetingCap: 2 }) });
    await seedDay();
    // 另一天的数据（不应被今天的日报影响）
    await chromeStub.storage.local.set({ 'jobAgentEvents:2026-09-12': [{ eventId: 'old', type: 'JOB_DISCOVERED', timestamp: '2026-09-12T10:00:00.000Z', jobId: 'old-1', metadata: {} }] });

    const report = await previewDailyReport({ date: DAY, now: localAt('18:00') });
    expect(report.summary.discovered).toBe(0); // 今天没有 JOB_DISCOVERED

    await generateDailyReportOnce({ date: DAY, now: localAt('18:00') });
    const otherDay = chromeStub.__store['jobAgentEvents:2026-09-12'] as unknown[];
    expect(otherDay).toHaveLength(1);
  });
});
