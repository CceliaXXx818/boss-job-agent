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
import * as states from './job-state.js';
import * as queue from './action-queue.js';
import * as records from './agent-records.js';
import * as policy from './autopilot-policy.js';
import * as greeting from './greeting-builder.js';
import * as ai from './ai-client.js';
import * as core from './core-logic.js';

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
const CONTENT_WAIT_TRIES = 12;
const CONTENT_WAIT_MS = 1500;

const GREET_LABELS = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '开始沟通', '打个招呼', '马上沟通', '立即开聊', '聊一聊', '发消息'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 浏览器适配器（唯一持有 chrome.tabs / content script 细节的地方） ----------------

function createBrowserAdapter() {
  const queryBossTabs = () => chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });

  async function readHealth(tabId) {
    try {
      const page = await chrome.tabs.sendMessage(tabId, { type: 'pageHealth' });
      return page ?? null;
    } catch {
      return null;
    }
  }

  /** 平台风险判定：只看 URL / 标题 / 卡片数量，不猜 DOM 选择器 */
  function classifyRisk(page) {
    const url = String(page?.url ?? '');
    const title = String(page?.title ?? '');
    const blob = `${url} ${title}`;
    if (/captcha|geetest|\/safe\/|verify|security-check/i.test(blob)) {
      return { risk: RISK_REASONS.CAPTCHA, reason: '检测到验证码/安全校验页面，已暂停，请人工处理 BOSS 页面' };
    }
    if (/\/web\/user\/|\/login|登录/i.test(blob)) {
      return { risk: RISK_REASONS.LOGIN_REQUIRED, reason: 'BOSS 登录状态已失效，请重新登录后再 Resume' };
    }
    if (/风险|异常|限制/i.test(title)) {
      return { risk: RISK_REASONS.RISK_PAGE, reason: `BOSS 页面提示异常（${title}），已暂停` };
    }
    if (/\/web\/geek\/jobs/.test(url) && Number(page?.cardCount ?? 0) === 0) {
      return {
        risk: RISK_REASONS.BROWSER_CONTEXT_INVALID,
        reason: '岗位列表为空（可能未登录或城市未选择），已暂停',
      };
    }
    return null;
  }

  /** 等待 content script 就绪（不是重试业务操作，只是等待页面可对话） */
  async function waitForContent(tabId) {
    for (let i = 0; i < CONTENT_WAIT_TRIES; i++) {
      const page = await readHealth(tabId);
      if (page) return page;
      await sleep(CONTENT_WAIT_MS);
    }
    return null;
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
    try {
      await chrome.tabs.get(rt.autopilotTabId);
    } catch {
      // 执行标签不存在不是"风险"，让 ensureTab 去重建（连续失败才 PAUSED）
      return { risk: null, tabMissing: true };
    }
    const page = await readHealth(rt.autopilotTabId);
    if (!page) return { risk: null };
    return classifyRisk(page) ?? { risk: null };
  }

  /** 保证存在唯一的 Autopilot 执行标签（优先复用，不抢占用户当前标签） */
  async function ensureTab(preferredId) {
    if (preferredId) {
      try {
        const tab = await chrome.tabs.get(preferredId);
        if (tab?.id) return { tabId: tab.id, reused: true };
      } catch {
        /* 标签已被用户关闭，重建 */
      }
    }
    let attempts = 0;
    while (attempts <= SAFE_RETRY) {
      attempts++;
      try {
        const created = await chrome.tabs.create({
          url: 'https://www.zhipin.com/web/geek/jobs',
          active: false,
        });
        const page = await waitForContent(created.id);
        if (page) {
          await patchRuntime((r) => ({ ...r, autopilotTabId: created.id, tabFailureCount: 0 }));
          return { tabId: created.id, reused: false };
        }
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
    let tabId = rt.autopilotTabId;
    if (tabId) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
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

  async function search(tabId, query) {
    const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query.keyword)}&city=${query.cityCode}`;
    let lastError = null;
    for (let attempt = 0; attempt <= SAFE_RETRY; attempt++) {
      await chrome.tabs.update(tabId, { url });
      await sleep(3000);
      for (let i = 0; i < CONTENT_WAIT_TRIES; i++) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'scrape' });
          if (res?.url && /\/chengshi\//.test(res.url)) {
            return { ok: false, risk: RISK_REASONS.BROWSER_CONTEXT_INVALID, reason: 'BOSS 跳转到城市页，需要人工选择城市' };
          }
          const page = await readHealth(tabId);
          const risk = classifyRisk(page);
          if (risk) return { ok: false, ...risk };
          if (res?.count > 0) return { ok: true, rows: res.rows ?? [], count: res.count, url: res.url };
          lastError = '岗位列表为空';
        } catch (e) {
          lastError = String(e?.message ?? e);
        }
        await sleep(CONTENT_WAIT_MS);
      }
    }
    const page = await readHealth(tabId);
    const risk = classifyRisk(page);
    if (risk) return { ok: false, ...risk };
    return { ok: false, error: `搜索失败：${lastError ?? '未知原因'}` };
  }

  async function detail(tabId, job) {
    let lastError = null;
    for (let attempt = 0; attempt <= SAFE_RETRY; attempt++) {
      try {
        await chrome.tabs.update(tabId, { url: `https://www.zhipin.com${job.href}` });
        await sleep(4200);
        const res = await chrome.tabs.sendMessage(tabId, { type: 'detailScrape' });
        const page = await readHealth(tabId);
        const risk = classifyRisk(page);
        if (risk) return { ok: false, ...risk };
        if (res?.ok !== false) return { ok: true, detail: res };
        lastError = res?.error ?? '详情解析失败';
      } catch (e) {
        lastError = String(e?.message ?? e);
      }
      await sleep(1200);
    }
    return { ok: false, error: `详情抓取失败：${lastError ?? '未知原因'}` };
  }

  async function greet(tabId, action) {
    try {
      await chrome.tabs.update(tabId, { url: `https://www.zhipin.com${action.payload?.href ?? ''}` });
      await sleep(4200);
      const page = await readHealth(tabId);
      const risk = classifyRisk(page);
      if (risk) return { ok: false, ...risk };
      const res = await chrome.tabs.sendMessage(tabId, {
        type: 'greetFull',
        labels: GREET_LABELS,
        text: action.payload?.message ?? '',
      });
      const ok = res?.ok === true && (res.stage === 'sent' || res.stage === 'sent_by_enter');
      if (ok) return { ok: true };
      return { ok: false, error: res?.detail ?? res?.stage ?? '打招呼未确认发送', stage: res?.stage ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  return { getContext, health, ensureTab, search, detail, greet, withTab, classifyRisk };
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
  ];
  if (!known.includes(message.type)) return false;
  handleCommand(message)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, reason: String(e?.message ?? e) }));
  return true; // 异步响应
});

// ---------------- 生命周期 ----------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name?.startsWith(TICK_ALARM)) return;
  runTick({ source: alarm.name }).catch((e) => console.error('[autopilot] tick failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  getEngine()
    .recoverInterrupted()
    .then(() => ensureAlarms())
    .then(() => runTick({ steps: 1, source: 'startup' }))
    .catch((e) => console.error('[autopilot] startup failed', e));
});

chrome.runtime.onInstalled.addListener(() => {
  getEngine()
    .recoverInterrupted()
    .catch((e) => console.error('[autopilot] install recovery failed', e));
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

console.log('[autopilot] background service worker ready', {
  maxStepsPerWake: MAX_STEPS_PER_WAKE,
  failureThreshold: FAILURE_THRESHOLD,
  steps: Object.values(AUTOPILOT_STEPS).length,
});
