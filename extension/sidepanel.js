// sidepanel.js —— Job Agent 主界面（ES module）
import {
  SUPPORTED_CITIES,
  canGreet,
  mergeExcludeTokens,
  hhmm,
} from './core-logic.js';

const AI_BASE = 'http://127.0.0.1:8799';
const AI_TIMEOUT = 3000;

const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);

export const session = {
  state: 'idle',
  goal: null,
  plan: null,
  searchedQueries: [],
  discoveredJobs: [],
  detailJobs: [],
  scoredJobs: [],
  activity: [],
  replanCount: 0,
  approved: false,
};

// ---------- 渲染工具 ----------
export function showState(name) {
  session.state = name;
  for (const [key, el] of [
    ['idle', $('stateIdle')],
    ['running', $('stateRunning')],
    ['complete', $('stateComplete')],
    ['stopped', $('stateStopped')],
  ]) {
    el.hidden = key !== name;
  }
}

export function addActivity(step, text) {
  session.activity.push({ t: hhmm(), step, text });
  for (const id of ['activityList', 'activityList2']) {
    const list = $(id);
    if (!list) continue;
    list.innerHTML = session.activity
      .map((a) => `<li><span class="t">${a.t}</span><span class="step">${a.step}</span> ${escapeHtml(a.text)}</li>`)
      .join('');
  }
}

export function setDecision(text) {
  $('decisionBox').textContent = text;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- 连接状态 ----------
async function checkBoss() {
  const tabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });
  const ok = tabs.length > 0;
  const b = $('bossBadge');
  b.textContent = ok ? 'BOSS 已连接' : 'BOSS 未连接';
  b.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
  return ok;
}

async function checkAi() {
  const b = $('aiBadge');
  try {
    const res = await fetch(`${AI_BASE}/health`, { signal: AbortSignal.timeout(AI_TIMEOUT) });
    const ok = res.ok;
    b.textContent = ok ? 'AI 服务已连接' : 'AI 服务异常';
    b.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
    return ok;
  } catch {
    b.textContent = 'AI 服务未连接';
    b.className = 'badge badge-idle';
    return false;
  }
}

// ---------- 配额显示 ----------
async function refreshQuota() {
  const cap = Number($('capInput').value) || 5;
  await chrome.storage.local.set({ dailyCap: cap });
  const key = `greet-${todayKey()}`;
  const st = await chrome.storage.local.get(key);
  const done = Number(st[key] ?? 0);
  $('quotaText').textContent = `${done} / ${cap}`;
  $('approveQuota').textContent = `${done} / ${cap}`;
  $('approveCap').textContent = String(cap);
}

// ---------- 打招呼话术（持久化） ----------
const DEFAULT_GREET =
  '您好，我有5年产品经理经验、其中2年专注AI方向，主导过智能客服、知识库问答等产品0-1落地，熟悉大模型应用与Agent工作流，希望进一步交流，谢谢。';

async function loadGreetText() {
  const st = await chrome.storage.local.get('greetText');
  $('greetText').value = st.greetText ?? DEFAULT_GREET;
}

// ---------- 启动流程（Phase 3 接入完整编排；Phase 1 仅入口校验） ----------
async function onStart() {
  const goal = $('goalInput').value.trim();
  const err = $('idleError');
  err.hidden = true;
  if (!goal) {
    err.textContent = '请先描述你的求职目标。';
    err.hidden = false;
    return;
  }
  session.goalRaw = goal;
  session.activity = [];
  session.replanCount = 0;
  session.searchedQueries = [];
  session.discoveredJobs = [];
  session.detailJobs = [];
  session.scoredJobs = [];
  showState('running');
  $('goalSummary').innerHTML = `<li><span>目标</span><b>${escapeHtml(goal)}</b></li>`;
  $('stateText').textContent = '规划中…';
  addActivity('Planning', '收到目标，正在生成搜索计划');
  if (typeof window.__jobAgentRun === 'function') {
    await window.__jobAgentRun(goal);
  } else {
    setDecision('Planner 尚未接入（Phase 2）。');
  }
}

// ---------- 绑定事件 ----------
function bind() {
  showState('idle');
  $('startBtn').onclick = onStart;
  $('stopBtn').onclick = () => {
    session.stopped = true;
    $('stateText').textContent = '将在当前动作后暂停…';
  };
  $('retryBtn').onclick = () => showState('idle');
  $('restartBtn').onclick = () => showState('idle');
  $('capInput').onchange = refreshQuota;
  $('toApproveBtn').onclick = () => {
    const selected = session.selectedIds?.size ?? 0;
    if (!selected) {
      $('completeError').hidden = false;
      $('completeError').textContent = '请先勾选要联系的岗位。';
      return;
    }
    $('approveBox').hidden = false;
    $('approveCount').textContent = String(selected);
  };
  $('cancelApprove').onclick = () => {
    $('approveBox').hidden = true;
  };
  $('approveBtn').onclick = async () => {
    session.approved = true;
    await chrome.storage.local.set({ greetText: $('greetText').value });
    if (typeof window.__jobAgentGreet === 'function') {
      await window.__jobAgentGreet();
    } else {
      $('completeError').hidden = false;
      $('completeError').textContent = '打招呼流程尚未接入（Phase 5）。';
    }
  };
}

async function init() {
  bind();
  await Promise.all([checkBoss(), checkAi()]);
  const st = await chrome.storage.local.get('dailyCap');
  if (st.dailyCap) $('capInput').value = st.dailyCap;
  await refreshQuota();
  await loadGreetText();
}

init();

export { AI_BASE, todayKey, refreshQuota, checkBoss, checkAi };
