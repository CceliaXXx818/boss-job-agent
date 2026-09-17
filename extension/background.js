// background.js —— V0.5 Phase 3：Background Service Worker（Autopilot 编排层）
//
// 职责（V0.5 §1）：
//   · Autopilot orchestration（事件驱动 Step Machine，不是长驻循环）
//   · persisted runtime state（唯一事实来源 = chrome.storage.local）
//   · scheduling（chrome.alarms）
//   · discovery step execution / action queue consumption / auto greeting
//   · pause / resume / platform risk handling
//
// 铁律：
//   · 没有 while(true)、没有 setInterval、没有跨小时的 await。
//   · 每次唤醒最多推进 MAX_STEPS_PER_WAKE 个 bounded step，每步都立即 persist。
//   · 所有浏览器操作都走 content.js 的确定性工具，Background 不猜 selector。
//   · Service Worker 被 suspend 后，靠 alarm / 浏览器事件 / 用户命令重新唤醒并续跑。

import { createAutopilotEngine, FAILURE_THRESHOLD } from './autopilot-engine.js';
import {
  AUTOPILOT_STATUS,
  AUTOPILOT_STEPS,
  RISK_REASONS,
  isActiveStatus,
  loadRuntime,
  patchRuntime,
} from './autopilot-runtime.js';
import * as settings from './settings.js';
import * as events from './event-store.js';
import { localDateKey } from './event-store.js';
import * as states from './job-state.js';
import * as queue from './action-queue.js';
import * as records from './agent-records.js';
import * as policy from './autopilot-policy.js';
import * as greeting from './greeting-builder.js';
import * as ai from './ai-client.js';
import * as core from './core-logic.js';
import * as dailyReport from './daily-report-service.js';
import {
  classifyMessageError,
  describePageState,
  pingTab,
  sendMessageReliably,
  shouldBringTabToFront,
  shouldRecycleTab,
  waitForContentReady,
} from './tab-messaging.js';
import { classifyPageRisk, inspectJobListPage } from './page-risk.js';

/** 每次唤醒最多推进的 bounded step 数（每个 step 之间都会 persist） */
export const MAX_STEPS_PER_WAKE = 3;
/** alarm 名称 */
export const TICK_ALARM = 'jobAgentAutopilotTick';
/** 快速 tick 的延迟（分钟）；Chrome 会把过小的值夹到其最小值 */
export const FAST_TICK_MINUTES = 0.5;
/** 后台巡检间隔（分钟） */
export const PERIODIC_TICK_MINUTES = 1;
/** 单个 bounded 浏览器操作的安全重试次数（V0.5 §31） */
export const SAFE_RETRY = 1;
/** 等待 content script 就绪的轮询次数与间隔 */
const CONTENT_WAIT_TRIES = 20;
const CONTENT_WAIT_MS = 800;
/** 单条消息的重试次数与间隔（处理"内容脚本还没就绪"这类可重试错误） */
const MESSAGE_TRIES = 3;
const MESSAGE_RETRY_MS = 800;
/** 等待内容脚本就绪时，每次轮询的间隔（与上面的 CONTENT_WAIT_MS 配合，上限约 16s） */
const CONTENT_READY_MS = CONTENT_WAIT_MS;
/** 抓到 0 条时的"再等等看"策略：列表是异步渲染的，不能一次为空就下结论 */
const EMPTY_LIST_RETRIES = 3;
const EMPTY_LIST_WAIT_MS = 1500;
/** 同一执行标签累计导航多少次后重建（长时间反复导航可能退化/卡死） */
const TAB_RECYCLE_AFTER = 40;

const GREET_LABELS = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '开始沟通', '打个招呼', '马上沟通', '立即开聊', '聊一聊', '发消息'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 浏览器适配器（唯一持有 chrome.tabs / content script 细节的地方） ----------------

function createBrowserAdapter() {
  const queryBossTabs = () => chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });

  /** 直接读标签页本身（不依赖 content script）：标签被关掉/跳到其它域名都能立刻发现 */
  async function getTabOrNull(tabId) {
    try {
      return (await chrome.tabs.get(tabId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 平台风险判定：委托给纯函数模块 page-risk.js（只依据 URL / 标题等事实）。
   * 注意：**不再**用"卡片数为 0"推断未登录/未选城市 —— 那会产生假阳性（无结果 / 未渲染）。
   */
  function classifyRisk(page, tab = null) {
    return classifyPageRisk({ page, tab });
  }

  /** 给等待/重试逻辑用的风险检查（不依赖 content script） */
  async function checkTabRisk(tabId) {
    const tab = await getTabOrNull(tabId);
    if (!tab) return { risk: RISK_REASONS.AUTOPILOT_TAB_UNAVAILABLE, reason: '执行标签已不存在（可能被手动关闭）' };
    return classifyRisk(null, tab) ?? null;
  }

  const send = (tabId, message) => chrome.tabs.sendMessage(tabId, message);
  const reload = async (tabId) => {
    try {
      await chrome.tabs.reload?.(tabId);
    } catch {
      /* reload 失败不影响主流程，后续仍会重试 */
    }
  };

  async function readHealth(tabId) {
    const page = await pingTab({ send, tabId });
    if (page) return page;
    // content script 未就绪时退化为"只凭标签信息"的健康快照
    const tab = await getTabOrNull(tabId);
    return tab ? { url: tab.url, title: tab.title, readyState: 'unknown', cardCount: null } : null;
  }

  async function getContext() {
    const tabs = await queryBossTabs();
    const ordered = [
      ...tabs.filter((t) => t.active),
      ...tabs.filter((t) => /\/web\/geek\//.test(t.url ?? '')),
      ...tabs,
    ].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
    for (const tab of ordered) {
      try {
        const page = await chrome.tabs.sendMessage(tab.id, { type: 'bossContext' });
        const ctx = core.resolveBossContext(page);
        if (ctx) return ctx;
      } catch {
        /* 该标签 content script 未就绪，试下一个 */
      }
    }
    return null;
  }

  async function health() {
    const rt = await loadRuntime();
    if (!rt.autopilotTabId) return { risk: null };
    const tab = await getTabOrNull(rt.autopilotTabId);
    if (!tab) return { risk: null, tabMissing: true };
    const page = await pingTab({ send, tabId: rt.autopilotTabId });
    return classifyRisk(page, tab) ?? { risk: null };
  }

  /** 保证存在唯一的 Autopilot 执行标签（优先复用，不抢占用户当前标签） */
  async function ensureTab(preferredId) {
    if (preferredId) {
      const tab = await getTabOrNull(preferredId);
      if (tab?.id) return { tabId: tab.id, reused: true };
    }
    let attempts = 0;
    while (attempts <= SAFE_RETRY) {
      attempts++;
      try {
        const created = await chrome.tabs.create({
          url: 'https://www.zhipin.com/web/geek/jobs',
          active: false,
        });
        const ready = await waitForContentReady({
          send,
          sleep,
          tabId: created.id,
          checkRisk: checkTabRisk,
          tries: CONTENT_WAIT_TRIES,
          delayMs: CONTENT_WAIT_MS,
        });
        if (ready.ok) {
          await patchRuntime((r) => ({ ...r, autopilotTabId: created.id, tabFailureCount: 0 }));
          return { tabId: created.id, reused: false };
        }
        if (ready.risk) return { risk: ready.risk, reason: ready.reason };
        throw new Error('执行标签页未就绪（content script 无响应）');
      } catch (e) {
        const last = String(e?.message ?? e);
        if (attempts > SAFE_RETRY) {
          const rt = await patchRuntime((r) => ({ ...r, tabFailureCount: (r.tabFailureCount ?? 0) + 1 }));
          return {
            risk: RISK_REASONS.AUTOPILOT_TAB_UNAVAILABLE,
            reason: `无法建立 Autopilot 执行标签（已重试 ${SAFE_RETRY} 次）：${last}｜失败计数 ${rt.tabFailureCount}`,
          };
        }
      }
    }
    return { risk: RISK_REASONS.AUTOPILOT_TAB_UNAVAILABLE, reason: '无法建立 Autopilot 执行标签' };
  }

  async function withTab(job) {
    const rt = await loadRuntime();
    // 自愈 ②：同一标签反复导航后可能退化 → 主动重建一个干净标签
    if (rt.autopilotTabId && shouldRecycleTab({ navigations: rt.tabNavCount ?? 0, threshold: TAB_RECYCLE_AFTER })) {
      try {
        await chrome.tabs.remove(rt.autopilotTabId);
      } catch {
        /* 标签可能已被关闭 */
      }
      await patchRuntime((r) => ({ ...r, autopilotTabId: null, tabNavCount: 0 }));
      console.log('[autopilot] 执行标签导航次数达到阈值，已重建');
    }
    let tabId = rt.autopilotTabId;
    if (tabId) {
      const tab = await getTabOrNull(tabId);
      if (!tab) {
        const rebuilt = await ensureTab(null);
        if (rebuilt?.risk) return rebuilt;
        tabId = rebuilt.tabId;
      }
    } else {
      const created = await ensureTab(null);
      if (created?.risk) return created;
      tabId = created.tabId;
    }
    return job(tabId);
  }

  /**
   * 统一的"导航 → 等就绪 → 发消息"流程。
   * 这是修复 `Receiving end does not exist` 的关键：**先等内容脚本就绪，再发业务消息**，
   * 并把可重试错误交给 sendMessageReliably（内部含一次 reload 兜底）。
   */
  async function navigateAndAsk(tabId, url, message, { validate = null, readyCheck = null } = {}) {
    const tabRisk = await checkTabRisk(tabId);
    if (tabRisk?.risk) return { ok: false, risk: tabRisk.risk, reason: tabRisk.reason };

    // 自愈 ①：连续页面级失败说明"后台标签可能渲染/交互受限" → 把它切到前台再试一次
    const rtBefore = await loadRuntime();
    if (shouldBringTabToFront({ consecutivePageFailures: rtBefore.consecutivePageFailures ?? 0 })) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        await sleep(1200);
        console.log('[autopilot] 连续页面级失败，已把执行标签切到前台重试');
      } catch {
        /* 切前台失败不影响后续流程 */
      }
    }

    await chrome.tabs.update(tabId, { url });

    // isUsable：不仅要求 content script 能应答，还要求**页面内容已经可用**
    // （真实事故：能应答但页面仍是"加载中"，打招呼必然找不到入口）
    const isUsable = readyCheck
      ? (page) => Boolean(page) && (page.loading === undefined || page.loading === false)
      : null;
    const waitReady = async () => {
      await waitForContentReady({
        send,
        sleep,
        tabId,
        checkRisk: checkTabRisk,
        isUsable,
        tries: CONTENT_WAIT_TRIES,
        delayMs: CONTENT_READY_MS,
      });
    };

    const ready = await waitForContentReady({
      send,
      sleep,
      tabId,
      checkRisk: checkTabRisk,
      isUsable,
      tries: CONTENT_WAIT_TRIES,
      delayMs: CONTENT_READY_MS,
    });
    // 记录导航次数（用于标签重建判断）
    await patchRuntime((r) => ({ ...r, tabNavCount: (r.tabNavCount ?? 0) + 1 }));

    if (!ready.ok) {
      if (ready.risk) return { ok: false, risk: ready.risk, reason: ready.reason };
      if (ready.timeout && readyCheck) {
        // 页面迟迟没离开加载态 → 这是"该页面"的问题，不是工具坏（上层按 kind 决定是否跳过）
        // 带上现场证据（标题/readyState/可见文字），否则用户只能看到"刷不开"
        return {
          ok: false,
          kind: 'page',
          error: `页面加载超时（内容始终处于加载中）${describePageState(ready.page)}`,
        };
      }
      return { ok: false, retryable: true, error: `${ready.reason ?? '页面未就绪'}${describePageState(ready.page)}` };
    }

    const sent = await sendMessageReliably({
      send,
      sleep,
      tabId,
      message,
      reload,
      checkRisk: checkTabRisk,
      waitReady,
      tries: MESSAGE_TRIES,
      retryMs: MESSAGE_RETRY_MS,
    });
    if (!sent.ok) return { ok: false, ...sent };

    const page = ready.page;
    const risk = classifyRisk(page, await getTabOrNull(tabId));
    if (risk) return { ok: false, ...risk };

    if (validate) {
      const verdict = validate(sent.response);
      if (!verdict.ok) {
        return {
          ok: false,
          retryable: true,
          error: verdict.error,
          kind: verdict.kind ?? null,
          stage: verdict.stage ?? null,
          response: sent.response,
        };
      }
    }
    return { ok: true, response: sent.response, page, reloaded: sent.reloaded };
  }

  async function search(tabId, query) {
    const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query.keyword)}&city=${query.cityCode}`;
    let lastError = null;
    let sawEmptyList = false;

    for (let attempt = 0; attempt <= SAFE_RETRY; attempt++) {
      const res = await navigateAndAsk(tabId, url, { type: 'scrape' });
      if (res.risk) return { ok: false, risk: res.risk, reason: res.reason };
      if (!res.ok) {
        lastError = res.error ?? '搜索失败';
        if (attempt < SAFE_RETRY) await sleep(CONTENT_WAIT_MS);
        continue;
      }

      const response = res.response ?? {};
      if (response.url && /\/chengshi\//.test(response.url)) {
        return { ok: false, risk: RISK_REASONS.BROWSER_CONTEXT_INVALID, reason: 'BOSS 跳转到城市页，需要人工选择城市' };
      }
      // 以**抓取结果**为准（避免用过期快照/健康信息误判）
      if (Number(response.count) > 0) {
        return { ok: true, rows: response.rows ?? [], count: response.count, url: response.url };
      }

      // 抓到 0 条：可能只是列表还没渲染完 → 再等几次；仍为空则视为"该关键词无结果"
      sawEmptyList = true;
      let recovered = null;
      for (let i = 0; i < EMPTY_LIST_RETRIES; i++) {
        await sleep(EMPTY_LIST_WAIT_MS);
        const again = await sendMessageReliably({
          send,
          sleep,
          tabId,
          message: { type: 'scrape' },
          reload,
          checkRisk: checkTabRisk,
          tries: MESSAGE_TRIES,
          retryMs: MESSAGE_RETRY_MS,
        });
        if (again.ok && Number(again.response?.count) > 0) {
          recovered = again.response;
          break;
        }
        if (!again.ok && again.risk) return { ok: false, risk: again.risk, reason: again.reason };
      }
      if (recovered) {
        return { ok: true, rows: recovered.rows ?? [], count: recovered.count, url: recovered.url };
      }

      // 真的是空结果：不是风险，也不是失败（交给引擎跳过该关键词继续）
      const listState = inspectJobListPage({ tab: await getTabOrNull(tabId) });
      if (listState.risk) return { ok: false, ...listState.risk };
      return { ok: true, rows: [], count: 0, url: response.url, empty: true };
    }

    const health = await checkTabRisk(tabId);
    if (health?.risk) return { ok: false, risk: health.risk, reason: health.reason };
    if (sawEmptyList) return { ok: true, rows: [], count: 0, empty: true };
    return { ok: false, error: `搜索失败：${lastError ?? '未知原因'}` };
  }

  /** 详情解析是否真的拿到了内容（避免"响应成功但页面还没渲染"被当成成功） */
  function hasDetailContent(res) {
    if (!res || res.ok === false) return false;
    return Boolean(String(res.descFull ?? '').length || res.name || res.salaryRaw || res.asciiSalary);
  }

  async function detail(tabId, job) {
    let lastError = null;
    let lastStage = null;
    for (let attempt = 0; attempt <= SAFE_RETRY; attempt++) {
      const res = await navigateAndAsk(tabId, `https://www.zhipin.com${job.href}`, { type: 'detailScrape' }, {
        readyCheck: true,
        validate: (response) =>
          hasDetailContent(response)
            ? { ok: true }
            : { ok: false, error: '详情内容为空（页面可能未渲染完）', stage: response?.stage ?? null, kind: 'page' },
      });
      if (res.risk) return { ok: false, risk: res.risk, reason: res.reason };
      if (res.ok) return { ok: true, detail: res.response };
      lastError = res.error ?? '详情解析失败';
      lastStage = res.stage ?? res.response?.stage ?? null;
      if (res.kind === 'page') break; // 页面级问题重试无益，直接交给上层跳过
      if (attempt < SAFE_RETRY) await sleep(1200);
    }
    const kind = classifyMessageError(lastError, lastStage);
    return { ok: false, kind, error: `详情抓取失败：${lastError ?? '未知原因'}` };
  }

  async function greet(tabId, action) {
    const res = await navigateAndAsk(
      tabId,
      `https://www.zhipin.com${action.payload?.href ?? ''}`,
      {
        type: 'greetFull',
        labels: GREET_LABELS,
        text: action.payload?.message ?? '',
      },
      { readyCheck: true },
    );
    if (res.risk) return { ok: false, ...res };
    if (!res.ok) return { ok: false, kind: res.kind ?? null, error: res.error ?? '打招呼未确认发送' };
    const response = res.response ?? {};
    const ok = response.ok === true && (response.stage === 'sent' || response.stage === 'sent_by_enter');
    if (ok) return { ok: true };
    // 消息已送达但发送未确认（入口没出现 / 点了没清空）→ 属于"这个页面的问题"，
    // 不回内部重试（可能已部分执行），交给 Action 记账，并按页面级失败处理。
    return {
      ok: false,
      kind: 'page',
      error: response.detail ?? response.stage ?? '打招呼未确认发送',
      stage: response.stage ?? null,
    };
  }

  return { getContext, health, ensureTab, search, detail, greet, withTab, classifyRisk, checkTabRisk, navigateAndAsk };
}

// ---------------- 引擎 ----------------

let engine = null;

function getEngine() {
  if (!engine) {
    engine = createAutopilotEngine({
      browser: createBrowserAdapter(),
      ai,
      settings,
      policy,
      greeting,
      queue,
      records,
      states,
      events,
      core,
      now: () => new Date(),
      onActivity: (text) => console.log('[autopilot]', text),
    });
  }
  return engine;
}

// ---------------- 调度 ----------------

let ticking = null;

async function ensureAlarms() {
  const rt = await loadRuntime();
  const active = isActiveStatus(rt.status);
  const alarm = await chrome.alarms.get(TICK_ALARM).catch(() => null);
  if (active && !alarm) {
    chrome.alarms.create(TICK_ALARM, { periodInMinutes: PERIODIC_TICK_MINUTES });
  }
  if (!active && alarm) {
    await chrome.alarms.clear(TICK_ALARM);
  }
  return { active, alarm: Boolean(alarm) };
}

/** 事件驱动的快速唤醒：不阻塞当前 tick */
function scheduleFastTick() {
  try {
    chrome.alarms.create(`${TICK_ALARM}-soon`, { delayInMinutes: FAST_TICK_MINUTES });
  } catch {
    /* 某些环境不支持极小延迟，周期 alarm 仍会兜底 */
  }
}

/**
 * 一次唤醒推进最多 MAX_STEPS_PER_WAKE 个 bounded step。
 * 可重入保护：同一时刻只允许一个 tick。
 */
async function runTick({ steps = MAX_STEPS_PER_WAKE, source = 'alarm' } = {}) {
  if (ticking) return { ok: true, skipped: true, reason: 'tick 已在进行中' };
  ticking = (async () => {
    const eng = getEngine();
    const results = [];
    for (let i = 0; i < steps; i++) {
      const r = await eng.advanceAutopilot();
      results.push(r);
      if (!r.advanced || r.done || r.status === AUTOPILOT_STATUS.PAUSED) break;
    }
    await ensureAlarms();
    console.log('[autopilot] tick', source, results.map((r) => `${r.status}/${r.step}`).join(' → '));
    return { ok: true, steps: results.length, last: results[results.length - 1] ?? null };
  })();
  try {
    return await ticking;
  } finally {
    ticking = null;
  }
}

// ---------------- 命令接口（Side Panel → Background） ----------------

export async function handleCommand(message) {
  const eng = getEngine();
  switch (message?.type) {
    case 'START_AUTOPILOT': {
      const res = await eng.startAutopilot({ rawGoal: message.goal });
      if (res.ok) scheduleFastTick();
      await ensureAlarms();
      // 启动 Autopilot 是 catch-up 的一个合适时机（V0.5 §17）
      await catchUpDailyReport();
      return res;
    }
    case 'PAUSE_AUTOPILOT': {
      const res = await eng.pauseByUser();
      await ensureAlarms();
      return res;
    }
    case 'RESUME_AUTOPILOT': {
      const res = await eng.resumeAutopilot();
      if (res.ok) scheduleFastTick();
      await ensureAlarms();
      return res;
    }
    case 'STOP_AUTOPILOT': {
      const res = await eng.stopAutopilot();
      await ensureAlarms();
      return res;
    }
    case 'GET_AUTOPILOT_STATUS':
      return eng.getStatus();
    case 'GET_DAILY_REPORT': {
      // 正式日报已生成 → 返回快照；否则实时预览（预览不写任何东西，V0.5 §18）
      const date = message.date ?? localDateKey();
      const snapshot = message.preview ? null : await dailyReport.getSnapshot(date);
      if (snapshot) {
        return {
          ok: true,
          source: 'snapshot',
          date: snapshot.date,
          generatedAt: snapshot.generatedAt,
          report: snapshot.report,
        };
      }
      const report = await dailyReport.previewDailyReport({ date: message.date ?? null });
      return { ok: true, source: 'preview', date: report.date, generatedAt: null, report };
    }
    case 'CATCH_UP_DAILY_REPORT': {
      // 时间感知：未到 dailyReportTime / 已生成 → 什么都不做（V0.5 §17）
      const res = await dailyReport.catchUpIfNeeded({ now: new Date() });
      return { ok: true, generated: res.generated, reason: res.reason, date: res.date ?? null };
    }
    case 'GENERATE_DAILY_REPORT': {
      // 显式生成（测试 / 未来"手动生成正式日报"按钮）：仍按 date 幂等
      const res = await dailyReport.generateDailyReportOnce({ date: message.date ?? null });
      return { ok: true, created: res.created, source: res.source, date: res.snapshot.date, report: res.snapshot.report };
    }
    case 'GET_DAILY_REPORT_STATUS': {
      const [check, snapshots, cfg] = await Promise.all([
        dailyReport.shouldCatchUp({}),
        dailyReport.listSnapshots({ limit: 30 }),
        settings.loadSettings(),
      ]);
      return { ok: true, enabled: cfg.dailyReportEnabled, reportTime: cfg.dailyReportTime, catchUp: check, snapshots };
    }
    case 'ADVANCE_AUTOPILOT': {
      // 仅用于调试/测试：手工推进一个 tick
      const res = await runTick({ steps: Number(message.steps) || 1, source: 'manual' });
      return { ...res, status: (await eng.getStatus()).status };
    }
    default:
      return { ok: false, reason: `未知命令：${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;
  const known = [
    'START_AUTOPILOT',
    'PAUSE_AUTOPILOT',
    'RESUME_AUTOPILOT',
    'STOP_AUTOPILOT',
    'GET_AUTOPILOT_STATUS',
    'ADVANCE_AUTOPILOT',
    'GET_DAILY_REPORT',
    'GENERATE_DAILY_REPORT',
    'CATCH_UP_DAILY_REPORT',
    'GET_DAILY_REPORT_STATUS',
  ];
  if (!known.includes(message.type)) return false;
  handleCommand(message)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, reason: String(e?.message ?? e) }));
  return true; // 异步响应
});

// ---------------- 生命周期 ----------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === dailyReport.REPORT_ALARM) {
    runDailyReport({ source: 'alarm' }).catch((e) => console.error('[daily-report] failed', e));
    return;
  }
  if (!alarm?.name?.startsWith(TICK_ALARM)) return;
  runTick({ source: alarm.name }).catch((e) => console.error('[autopilot] tick failed', e));
});

/** 生成正式日报（幂等）+ 重新排下一天的 alarm */
async function runDailyReport({ source = 'alarm' } = {}) {
  const res = await dailyReport.catchUpIfNeeded({ now: new Date() });
  await dailyReport.ensureDailyReportAlarm({ now: new Date() });
  console.log('[daily-report]', source, res.reason, res.generated ? 'generated' : 'skipped');
  return res;
}

/** catch-up：任何"合适的唤醒点"都调用（幂等，已生成则立刻返回） */
async function catchUpDailyReport() {
  try {
    return await runDailyReport({ source: 'catch-up' });
  } catch (e) {
    console.error('[daily-report] catch-up failed', e);
    return { ok: false, generated: false, reason: String(e?.message ?? e) };
  }
}

chrome.runtime.onStartup.addListener(() => {
  getEngine()
    .recoverInterrupted()
    .then(() => ensureAlarms())
    .then(() => runDailyReport({ source: 'startup' })) // 18:00 没开着 → 启动时补生成
    .then(() => runTick({ steps: 1, source: 'startup' }))
    .catch((e) => console.error('[autopilot] startup failed', e));
});

chrome.runtime.onInstalled.addListener(() => {
  getEngine()
    .recoverInterrupted()
    .catch((e) => console.error('[autopilot] install recovery failed', e))
    .then(() => dailyReport.ensureDailyReportAlarm({ now: new Date() }))
    .catch((e) => console.error('[daily-report] install alarm failed', e));
});

// 执行标签导航完成后立即推进一步：事件驱动，而不是定时轮询
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  loadRuntime()
    .then((rt) => {
      if (rt.autopilotTabId !== tabId) return undefined;
      if (!isActiveStatus(rt.status)) return undefined;
      return runTick({ steps: 1, source: 'tab-updated' });
    })
    .catch(() => {});
});

dailyReport
  .ensureDailyReportAlarm({ now: new Date() })
  .then((r) => console.log('[daily-report] alarm', r))
  .catch((e) => console.error('[daily-report] alarm failed', e));

console.log('[autopilot] background service worker ready', {
  maxStepsPerWake: MAX_STEPS_PER_WAKE,
  failureThreshold: FAILURE_THRESHOLD,
  steps: Object.values(AUTOPILOT_STEPS).length,
});
