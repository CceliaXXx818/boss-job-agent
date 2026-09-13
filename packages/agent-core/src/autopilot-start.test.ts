// V0.5 Phase 3 测试组 A：Start 校验 + AUTOPILOT_STARTED + cap 已满直接收工
import { describe, it, expect, afterEach, vi } from 'vitest';
import { autopilotSettings, createHarness, makeJob, type HarnessOptions } from './helpers/autopilot-harness.js';
import { AUTOPILOT_STATUS, loadRuntime } from '../../../extension/autopilot-runtime.js';
import { EVENT_TYPES, getEventsByDate, localDateKey } from '../../../extension/event-store.js';
import { getAllActions } from '../../../extension/action-queue.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 建一个带合法 Autopilot 设置的 harness（设置直接落在 storage 里，模拟用户已完成配置） */
function makeHarness(opts: HarnessOptions = {}, settingsOver: Record<string, unknown> = {}) {
  return createHarness({
    ...opts,
    initialStorage: {
      jobAgentSettings: autopilotSettings(settingsOver),
      ...(opts.initialStorage ?? {}),
    },
  });
}

const GOAL = '上海 AI 产品经理';

describe('A. Start 校验（V0.5 §10）', () => {
  it('Review 模式 → 不能启动（MODE_INVALID）', async () => {
    const h = makeHarness({}, { mode: 'review' });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MODE_INVALID');
    expect(await loadRuntime()).toMatchObject({ status: AUTOPILOT_STATUS.IDLE });
  });

  it('未授权 Autopilot → 不能启动（CONSENT_INVALID）', async () => {
    const h = makeHarness({}, { consent: { autopilot: false, autopilotAt: null, autoResume: false, autoResumeAt: null } });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CONSENT_INVALID');
    expect(h.calls.search).toEqual([]);
  });

  it('话术不可用（选择了尚未实现的 jd_personalized）→ 不能启动（TEMPLATE_INVALID）', async () => {
    const h = makeHarness({}, { greetingStrategy: { mode: 'jd_personalized', templateId: 'default', template: '你好' } });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TEMPLATE_INVALID');
    expect(res.reason).toContain('尚未实现');
  });

  it('工作时间外 → 不能启动（OUTSIDE_WORKING_HOURS）', async () => {
    const h = makeHarness({ now: new Date('2026-09-13T22:00:00') }, { workingHours: { start: '09:00', end: '18:00' } });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('OUTSIDE_WORKING_HOURS');
    expect(res.reason).toContain('09:00-18:00');
  });

  it('无法识别 Browser Context → 不能启动（BROWSER_CONTEXT_INVALID）', async () => {
    const h = makeHarness({ context: null });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('BROWSER_CONTEXT_INVALID');
  });

  it('平台风险页面 → 不能启动（CAPTCHA）', async () => {
    const h = makeHarness();
    h.browser.health = async () => ({ risk: 'CAPTCHA', reason: '页面出现验证码' });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CAPTCHA');
  });

  it('AI 服务不可用 → 不能启动（AI_SERVICE_UNAVAILABLE）', async () => {
    const h = makeHarness();
    h.ai.checkHealth = async () => ({ ok: false, error: 'AI 服务未连接，请先运行 npm run score:serve' });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AI_SERVICE_UNAVAILABLE');
    expect(res.reason).toContain('score:serve');
  });

  it('空 Goal → 不能启动（NO_GOAL）', async () => {
    const h = makeHarness();
    const res = await h.engine.startAutopilot({ rawGoal: '   ' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_GOAL');
  });

  it('失败时不会留下任何 runtime 会话或事件', async () => {
    const h = makeHarness({}, { mode: 'review' });
    await h.engine.startAutopilot({ rawGoal: GOAL });
    const rt = await loadRuntime();
    expect(rt.sessionId).toBeNull();
    expect(rt.status).toBe(AUTOPILOT_STATUS.IDLE);
    const evs = await getEventsByDate(localDateKey());
    expect(evs.filter((e) => e.type === EVENT_TYPES.AUTOPILOT_STARTED)).toHaveLength(0);
    expect(await getAllActions()).toEqual([]);
  });
});

describe('A2. 合法配置 → STARTED 并写入持久化 runtime', () => {
  it('启动成功：AUTOPILOT_STARTED 事件 + runtime 落盘（PLANNING / PLAN）', async () => {
    const h = makeHarness();
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(AUTOPILOT_STATUS.PLANNING);

    const rt = await loadRuntime();
    expect(rt.status).toBe(AUTOPILOT_STATUS.PLANNING);
    expect(rt.step).toBe('PLAN');
    expect(rt.rawGoal).toBe(GOAL);
    expect(rt.browserContext).toMatchObject({ cityName: '上海', cityCode: '101020100' });
    expect(rt.sessionId).toMatch(/^ap_/);
    expect(rt.todayGreetingCount).toBe(0);
    expect(rt.autopilotTabId).toBe(101);
    expect(rt.log.length).toBeGreaterThan(0);
    expect(h.chromeStub.__store['jobAgentAutopilotRuntime']).toBeTruthy();

    const started = (await getEventsByDate(localDateKey())).find((e) => e.type === EVENT_TYPES.AUTOPILOT_STARTED);
    expect(started).toBeTruthy();
    expect(started?.metadata.city).toBe('上海');
    expect(started?.metadata.dailyGreetingCap).toBe(5);
    expect(started?.idempotencyKey).toContain('autopilot-started:');
  });

  it('runtime 只包含可 JSON 化数据（可被 SW 安全持久化）', async () => {
    const h = makeHarness();
    await h.engine.startAutopilot({ rawGoal: GOAL });
    const raw = h.chromeStub.__store['jobAgentAutopilotRuntime'];
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
    const flat = JSON.stringify(raw);
    for (const banned of ['function', 'HTMLDivElement', '[object Object]']) {
      expect(flat.includes(banned)).toBe(false);
    }
  });
});

describe('A3. cap 已满：不进入 Discovery，直接 OUTREACH_COMPLETE', () => {
  it('今日已联系数 = cap 时 Start 直接收工（不调用 planner、不搜索、不打招呼）', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 95 })] },
      { dailyGreetingCap: 1 },
    );
    // 写入 legacy 计数：今天已经联系过 1 个
    await h.chromeStub.storage.local.set({ [`greet-${localDateKey()}`]: 1 });

    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(AUTOPILOT_STATUS.OUTREACH_COMPLETE);
    expect(res.reason).toBe('DAILY_CAP_REACHED');
    expect(h.calls.plan).toBe(0);
    expect(h.calls.search).toEqual([]);

    await h.advance(3);
    expect(h.calls.search).toEqual([]);
    expect(h.calls.greet).toEqual([]);
    const rt = await loadRuntime();
    expect([AUTOPILOT_STATUS.OUTREACH_COMPLETE, AUTOPILOT_STATUS.MONITORING]).toContain(rt.status);
  });

  it('cap 取自 max(事件, legacy 本地键, legacy UTC 键)', async () => {
    const h = makeHarness(
      { jobs: [makeJob({ jobId: 'j-1', score: 95 })] },
      { dailyGreetingCap: 2 },
    );
    await h.chromeStub.storage.local.set({ [`greet-${localDateKey()}`]: 2, greetedHistory: ['legacy-1'] });
    const res = await h.engine.startAutopilot({ rawGoal: GOAL });
    expect(res.status).toBe(AUTOPILOT_STATUS.OUTREACH_COMPLETE);
    expect(h.calls.greet).toEqual([]);
  });
});
