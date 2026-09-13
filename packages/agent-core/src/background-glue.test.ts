// V0.5 Phase 3：Background SW 胶水层测试
// 用假的 chrome API 真正 import background.js，验证命令注册、alarm 调度、tab 策略、
// 以及"不依赖 Side Panel 也能推进"的接线（不调用任何真实 AI 服务，保证 CI 可离线运行）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { localDateKey } from '../../../extension/event-store.js';
import { autopilotSettings } from './helpers/autopilot-harness.js';

type Listener = (msg: any, sender: any, respond: (r: any) => void) => unknown;

let store: Record<string, unknown>;
let messageHandlers: Listener[];
let alarmNames: string[];
let createdTabs: Array<Record<string, unknown>>;
let tabUpdates: string[];
let sentToContent: string[];
let bossTabsAvailable = true;
let createTabFails = false;

function pageResponse(msg: { type: string }, url: string) {
  switch (msg.type) {
    case 'pageHealth':
      return { ok: true, url, title: 'BOSS直聘', readyState: 'complete', cardCount: 20 };
    case 'bossContext':
      // 与 content.js bossContext 的真实返回结构一致：URL 里带 city code 时用 codeFromUrl
      return {
        ok: true,
        url,
        codeFromUrl: '101020100',
        codeCandidates: [{ code: '101020100', text: '上海' }],
        domCandidates: [{ text: '上海' }],
        topTexts: ['上海'],
      };
    default:
      return { ok: false, error: `unexpected message ${msg.type}` };
  }
}

function installChromeApi() {
  const storage = {
    async get(keys?: unknown) {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k as string] = store[k as string];
      return out;
    },
    async set(obj: Record<string, unknown>) {
      Object.assign(store, obj);
    },
    async remove(keys: unknown) {
      for (const k of (Array.isArray(keys) ? keys : [keys]) as string[]) delete store[k];
    },
  };

  (globalThis as any).chrome = {
    storage: { local: storage, onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener: (fn: Listener) => messageHandlers.push(fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage: async () => ({ ok: true }),
    },
    alarms: {
      create: (name: string) => alarmNames.push(name),
      get: async () => null,
      clear: async () => true,
      onAlarm: { addListener() {} },
    },
    tabs: {
      query: async () =>
        bossTabsAvailable ? [{ id: 7, url: 'https://www.zhipin.com/web/geek/jobs?city=101020100', active: true }] : [],
      get: async (id: number) => (id === 101 ? { id: 101, url: 'https://www.zhipin.com/web/geek/jobs' } : Promise.reject(new Error('no tab'))),
      create: async (opts: Record<string, unknown>) => {
        createdTabs.push(opts);
        if (createTabFails) throw new Error('模拟无法创建标签页');
        return { id: 101 };
      },
      update: async (_id: number, opts: { url: string }) => {
        tabUpdates.push(opts.url);
        return { id: 101 };
      },
      sendMessage: async (_id: number, msg: { type: string }) => {
        sentToContent.push(msg.type);
        return pageResponse(msg, 'https://www.zhipin.com/web/geek/jobs?city=101020100');
      },
      onUpdated: { addListener() {} },
    },
  };
}

async function loadBackground() {
  vi.resetModules();
  return import('../../../extension/background.js');
}

beforeEach(() => {
  store = {};
  messageHandlers = [];
  alarmNames = [];
  createdTabs = [];
  tabUpdates = [];
  sentToContent = [];
  bossTabsAvailable = true;
  createTabFails = false;
  installChromeApi();
});

afterEach(() => {
  vi.resetModules();
  delete (globalThis as any).chrome;
});

describe('Background 命令接口', () => {
  it('注册了 onMessage 监听器并识别命令（未知命令不处理）', async () => {
    const bg = await loadBackground();
    expect(messageHandlers.length).toBe(1);

    const unknown = await new Promise((resolve) => {
      const handled = messageHandlers[0]({ type: 'NOT_A_COMMAND' }, {}, resolve);
      expect(handled).toBe(false); // 返回 false 表示不接管
      setTimeout(() => resolve('__not_handled__'), 5);
    });
    expect(unknown).toBe('__not_handled__');

    const status = await bg.handleCommand({ type: 'GET_AUTOPILOT_STATUS' });
    expect(status.ok).toBe(true);
    expect(status.status).toBe('IDLE');
    expect(status.dailyGreetingCap).toBe(5);
  });

  it('GET_AUTOPILOT_STATUS 汇总队列与岗位状态', async () => {
    await (await loadBackground()).handleCommand({ type: 'GET_AUTOPILOT_STATUS' });
    const bg = await loadBackground();
    const status = await bg.handleCommand({ type: 'GET_AUTOPILOT_STATUS' });
    expect(status.queue).toMatchObject({ pending: 0, success: 0 });
    expect(status.jobStates).toEqual({});
  });

  it('START_AUTOPILOT：未授权/Review 模式会被 Background 再次拒绝（不只靠前端）', async () => {
    store['jobAgentSettings'] = autopilotSettings({ mode: 'review' });
    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'START_AUTOPILOT', goal: '上海 AI 产品经理' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MODE_INVALID');
    expect(alarmNames).toEqual([]); // 未启动就不该排期
  });

  it('START_AUTOPILOT：cap 已满 → 直接 OUTREACH_COMPLETE，并建立唯一的执行标签', async () => {
    store['jobAgentSettings'] = autopilotSettings({ dailyGreetingCap: 1 });
    store[`greet-${localDateKey()}`] = 1;

    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'START_AUTOPILOT', goal: '上海 AI 产品经理' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('OUTREACH_COMPLETE');

    // 建立了 1 个 inactive 执行标签（不抢占用户当前标签）
    expect(createdTabs).toHaveLength(1);
    expect(createdTabs[0]).toMatchObject({ active: false });
    expect(store['jobAgentAutopilotRuntime']).toMatchObject({ autopilotTabId: 101 });

    // 通过 content script 读取过页面健康（Background 不猜 selector）
    expect(sentToContent).toContain('pageHealth');
    // 收工状态不会再排 tick
    expect(alarmNames).not.toContain('jobAgentAutopilotTick');
  });

  it('PAUSE_AUTOPILOT：立即持久化 PAUSED 并写入 AUTOPILOT_PAUSED 事件', async () => {
    store['jobAgentSettings'] = autopilotSettings();
    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'PAUSE_AUTOPILOT' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('PAUSED');
    expect((store['jobAgentAutopilotRuntime'] as any).pauseReason).toBe('用户暂停');
    const dates = Object.keys(store).filter((k) => k.startsWith('jobAgentEvents:'));
    expect(dates.length).toBeGreaterThan(0);
    const events = dates.flatMap((d) => store[d] as any[]);
    expect(events.some((e) => e.type === 'AUTOPILOT_PAUSED')).toBe(true);
  });

  it('RESUME_AUTOPILOT：关键条件失效时拒绝恢复并保持 PAUSED', async () => {
    store['jobAgentSettings'] = autopilotSettings();
    const bg = await loadBackground();
    await bg.handleCommand({ type: 'PAUSE_AUTOPILOT' });

    // 把 BOSS 标签关掉 → Browser Context 不可识别（不依赖本机 AI 服务是否在跑）
    bossTabsAvailable = false;
    const res = await bg.handleCommand({ type: 'RESUME_AUTOPILOT' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('BROWSER_CONTEXT_INVALID');
    expect((store['jobAgentAutopilotRuntime'] as any).status).toBe('PAUSED');
    expect((store['jobAgentAutopilotRuntime'] as any).paused).toBe(true);
  });

  it('RESUME_AUTOPILOT：条件齐全时恢复运行（AI 服务可用与否由环境决定）', async () => {
    store['jobAgentSettings'] = autopilotSettings();
    const bg = await loadBackground();
    await bg.handleCommand({ type: 'PAUSE_AUTOPILOT' });
    const res = await bg.handleCommand({ type: 'RESUME_AUTOPILOT' });
    if (res.ok) {
      expect((store['jobAgentAutopilotRuntime'] as any).paused).toBe(false);
      const dates = Object.keys(store).filter((k) => k.startsWith('jobAgentEvents:'));
      const events = dates.flatMap((d) => store[d] as any[]);
      expect(events.some((e) => e.type === 'AUTOPILOT_RESUMED')).toBe(true);
    } else {
      // 本机 AI 服务未启动时：必须明确给出原因并保持 PAUSED
      expect(res.code).toBe('AI_SERVICE_UNAVAILABLE');
      expect((store['jobAgentAutopilotRuntime'] as any).status).toBe('PAUSED');
    }
  });

  it('STOP_AUTOPILOT：保留 Events / Queue / Job State', async () => {
    store['jobAgentSettings'] = autopilotSettings();
    store['jobAgentActions'] = [{ actionId: 'act_1', type: 'GREETING', jobId: 'j-1', status: 'success' }];
    store['jobAgentJobStates'] = { 'j-1': { jobId: 'j-1', state: 'GREETED' } };
    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'STOP_AUTOPILOT' });
    expect(res.ok).toBe(true);
    expect((store['jobAgentAutopilotRuntime'] as any).status).toBe('STOPPED');
    expect(store['jobAgentActions']).toHaveLength(1);
    expect((store['jobAgentJobStates'] as any)['j-1'].state).toBe('GREETED');
  });

  it('执行标签被用户关掉 → 重建一次并记录新的 autopilotTabId（V0.5 §18）', async () => {
    store['jobAgentSettings'] = autopilotSettings({ dailyGreetingCap: 1 });
    store[`greet-${localDateKey()}`] = 1; // cap 已满：不触发 AI 调用
    store['jobAgentAutopilotRuntime'] = { version: 1, date: localDateKey(), status: 'IDLE', autopilotTabId: 999 };

    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'START_AUTOPILOT', goal: '上海 AI 产品经理' });
    expect(res.ok).toBe(true);
    expect(createdTabs).toHaveLength(1); // 旧标签不存在 → 重建
    expect((store['jobAgentAutopilotRuntime'] as any).autopilotTabId).toBe(101);
  });

  it('连续无法建立执行标签 → START 失败并给出 AUTOPILOT_TAB_UNAVAILABLE（不无限重建）', async () => {
    store['jobAgentSettings'] = autopilotSettings();
    createTabFails = true;
    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'START_AUTOPILOT', goal: '上海 AI 产品经理' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AUTOPILOT_TAB_UNAVAILABLE');
    // 只尝试了 1 次 + 1 次安全重试（不是无限重建）
    expect(createdTabs).toHaveLength(2);
  });

  it('未知命令返回结构化失败而不是抛错', async () => {
    const bg = await loadBackground();
    const res = await bg.handleCommand({ type: 'DO_SOMETHING' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('未知命令');
  });
});

describe('Background 不依赖 Side Panel', () => {
  it('没有任何 UI 相关 API（不打开 sidePanel、不依赖 DOM）', async () => {
    const bg = await loadBackground();
    const src = bg.handleCommand.toString();
    expect(src).not.toContain('sidePanel');
    expect((globalThis as any).chrome.sidePanel).toBeUndefined();
  });
});
