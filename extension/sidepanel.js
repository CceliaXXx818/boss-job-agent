// sidepanel.js —— Job Agent 主界面（ES module）
// 原则：LLM 决定 WHAT（Plan/Replan），core-logic 决定规则允许范围，content.js 决定 HOW（DOM 动作）。
import {
  canGreet,
  mergeExcludeTokens,
  hardFilter,
  selectDetailTargets,
  rankJobs,
  shouldReplan,
  applyReplanQueries,
  MAX_REPLAN,
  hhmm,
} from './core-logic.js';

const AI_BASE = 'http://127.0.0.1:8799';
const AI_TIMEOUT = 3000;
const DETAIL_LIMIT = 15;

const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  stopped: false,
  selectedIds: new Set(),
};

// ---------------- UI 工具 ----------------
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
  const html = session.activity
    .map((a) => `<li><span class="t">${a.t}</span><span class="step">${a.step}</span> ${escapeHtml(a.text)}</li>`)
    .join('');
  for (const id of ['activityList', 'activityList2']) {
    const list = $(id);
    if (list) list.innerHTML = html;
  }
}

export function setDecision(text) {
  $('decisionBox').textContent = text;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function setStats() {
  const strong = session.scoredJobs.filter((j) => j.__ai?.ok && j.__ai.score >= 75).length;
  $('statDiscovered').textContent = String(session.discoveredJobs.length);
  $('statQualified').textContent = String(session.qualifiedJobs?.length ?? 0);
  $('statStrong').textContent = String(strong);
}

function renderGoalSummary(goal) {
  $('goalSummary').innerHTML = [
    `<li><span>城市</span><b>${escapeHtml(goal.cities.map((c) => c.name).join('、') || '—')}</b></li>`,
    `<li><span>方向</span><b>${escapeHtml(goal.targetTitles.join('、') || '—')}</b></li>`,
    `<li><span>薪资要求</span><b>${goal.salaryMinK ? `${goal.salaryMinK}K 以上` : '不限'}</b></li>`,
    `<li><span>硬排除项</span><b>${escapeHtml(goal.excludeTokens.join('、') || '—')}</b></li>`,
  ].join('');
}

function renderPlanList(queries) {
  $('planList').innerHTML = queries
    .map(
      (q, i) =>
        `<li data-i="${i}"><span>${escapeHtml(q.cityName)} · ${escapeHtml(q.keyword)}${q.source === 'replan' ? '（Replan）' : ''}</span><span class="status" data-status="${i}">waiting</span></li>`,
    )
    .join('');
  $('planProgress').textContent = '';
}
function markPlan(i, status) {
  const el = document.querySelector(`[data-status="${i}"]`);
  if (el) {
    el.textContent = status;
    el.className = `status status-${status}`;
  }
  const done = session.searchedQueries.length;
  $('planProgress').textContent = `${done} / ${session.plan?.queries.length ?? 0}`;
}

function stop(message) {
  session.stopped = true;
  $('stoppedBox').textContent = message;
  showState('stopped');
  addActivity('Stopped', message);
}

// ---------------- BOSS 浏览器工具（复用 content.js 已验证链路） ----------------
async function findBossTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });
  const pick = tabs.find((t) => /\/web\/geek\//.test(t.url)) ?? tabs[0];
  if (!pick) throw new Error('未找到 BOSS 标签页，请先在 Chrome 打开并登录 BOSS 后再开始。');
  return pick;
}

async function sendTab(tabId, payload) {
  return await chrome.tabs.sendMessage(tabId, payload);
}

async function gotoSearch(tabId, query) {
  const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query.keyword)}&city=${query.cityCode}`;
  await chrome.tabs.update(tabId, { url });
  await sleep(3500);
  for (let i = 0; i < 15; i++) {
    try {
      const res = await sendTab(tabId, { type: 'scrape' });
      if (res?.url && /\/chengshi\/|\/shenzhen\/|\/hangzhou\//.test(res.url)) {
        throw new Error('BOSS 跳转到城市页（可能需要人工处理）');
      }
      if (res?.count > 0) return res;
    } catch (e) {
      if (String(e?.message ?? '').includes('人工处理')) throw e;
    }
    await sleep(2500);
  }
  throw new Error('等待岗位列表超时（可能未登录 / 出现验证码）');
}

async function fetchDetail(tabId, job) {
  await chrome.tabs.update(tabId, { url: `https://www.zhipin.com${job.href}` });
  await sleep(4200);
  return await sendTab(tabId, { type: 'detailScrape' });
}

// ---------------- Agent Loop（Phase 3：Goal→Plan→Search→Filter→Detail→Score→Results） ----------------
export async function runAgent(rawGoal) {
  try {
    // 1) Plan
    $('stateText').textContent = 'planning';
    addActivity('Planning', '正在生成搜索计划');
    const planRes = await fetch(`${AI_BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: rawGoal }),
      signal: AbortSignal.timeout(60000),
    }).then((r) => r.json());
    if (!planRes?.ok) throw new Error(`规划失败：${planRes?.error ?? 'AI 服务未就绪（请先 npm run score:serve）'}`);
    const { goal, queries, warnings, successCriteria } = planRes.plan;
    session.goal = goal;
    session.plan = { goal, queries, successCriteria };
    session.warnings = warnings ?? [];
    renderGoalSummary(goal);
    renderPlanList(queries);
    if (!queries.length) throw new Error('计划中没有可用的搜索任务（城市可能不受支持）');

    // 每日上限（以 Goal 为准，不超过 10）
    const cap = Math.min(Number(goal.dailyGreetingCap) || 5, 10);
    $('capInput').value = cap;
    await chrome.storage.local.set({ dailyCap: cap });
    await refreshQuota();

    // 2) 排除词 = 画像 + Goal（硬约束最高优先级）
    let candidateExclude = [];
    try {
      const cfg = await fetch(`${AI_BASE}/config`, { signal: AbortSignal.timeout(AI_TIMEOUT) }).then((r) => r.json());
      candidateExclude = cfg?.candidate?.excludeTokens ?? [];
    } catch { /* 服务不可用时仅用 Goal 排除项 */ }
    const excludeTokens = mergeExcludeTokens(candidateExclude, goal.excludeTokens);

    // 3) 搜索（顺序执行，始终复用同一 BOSS 标签页）
    const tab = await findBossTab();
    $('stateText').textContent = 'searching';
    const discovered = new Map();
    for (let qi = 0; qi < queries.length; qi++) {
      if (session.stopped) return;
      const q = queries[qi];
      markPlan(qi, 'running');
      try {
        const res = await gotoSearch(tab.id, q);
        let added = 0;
        for (const row of res.rows) {
          if (!discovered.has(row.jobId)) {
            discovered.set(row.jobId, { ...row, fromQuery: `${q.cityName}·${q.keyword}` });
            added++;
          }
        }
        session.searchedQueries.push(q);
        addActivity('Search', `${q.cityName} · ${q.keyword}：发现 ${res.count} 个岗位（新增 ${added}）`);
        markPlan(qi, 'done');
      } catch (e) {
        markPlan(qi, 'failed');
        addActivity('Search', `${q.cityName} · ${q.keyword} 失败：${e?.message ?? e}`);
        throw e;
      }
    }
    session.discoveredJobs = [...discovered.values()];
    setStats();

    // 4) Hard filter（规则优先级高于任何模型分数）
    $('stateText').textContent = 'filtering';
    const qualified = [];
    let removed = 0;
    for (const j of session.discoveredJobs) {
      const r = hardFilter(j, excludeTokens);
      if (r.pass) qualified.push(j);
      else removed++;
    }
    session.qualifiedJobs = qualified;
    session.fetchedDetailIds = new Set();
    addActivity('Filter', `移除 ${removed} 个（命中排除词），保留 ${qualified.length} 个`);
    setStats();

    // 5) 详情（只抓 Top N，且只抓没抓过的）
    $('stateText').textContent = 'fetching_details';
    const targets = selectDetailTargets(qualified, session.fetchedDetailIds, DETAIL_LIMIT);
    addActivity('Detail', `选取 ${targets.length} 个岗位抓详情（上限 ${DETAIL_LIMIT}）`);
    let consecutiveFail = 0;
    for (const job of targets) {
      if (session.stopped) return;
      try {
        const detail = await fetchDetail(tab.id, job);
        session.fetchedDetailIds.add(job.jobId);
        session.detailJobs.push({
          ...job,
          ...detail,
          expEdu: detail?.expEdu?.length ? detail.expEdu : String(job.tags ?? '').split('|').filter(Boolean),
        });
        consecutiveFail = 0;
      } catch (e) {
        consecutiveFail++;
        addActivity('Detail', `${job.title} 抓取失败：${e?.message ?? e}`);
        if (consecutiveFail >= 3) throw new Error('连续 3 个详情抓取失败，BOSS 页面可能需要人工处理');
      }
    }
    addActivity('Detail', `详情完成 ${session.detailJobs.length} / ${targets.length}`);

    // 6) AI Score（复用 /score 与 candidate.json）
    $('stateText').textContent = 'scoring';
    const scoreRes = await fetch(`${AI_BASE}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobs: session.detailJobs.map((j) => ({
          jobId: j.jobId,
          title: j.title || j.name || '',
          company: j.company || '',
          area: j.area || '',
          salaryAscii: j.asciiSalary || '',
          expEdu: j.expEdu || [],
          companyMeta: j.companyMeta || [],
          descFull: j.descFull || '',
        })),
        salaryMinK: goal.salaryMinK ?? undefined,
      }),
      signal: AbortSignal.timeout(180000),
    }).then((r) => r.json());
    const byId = new Map((scoreRes?.results ?? []).map((r) => [r.jobId, r]));
    session.scoredJobs = session.detailJobs.map((j) => ({ ...j, __ai: byId.get(j.jobId) }));
    const strong = session.scoredJobs.filter((j) => j.__ai?.ok && j.__ai.score >= 75);
    addActivity('Score', `${strong.length} 个岗位得分 ≥ 75`);
    setStats();

    // 7) Evaluate（Replan 在 Phase 4 接入）
    $('stateText').textContent = 'evaluating';
    const target = successCriteria.targetQualifiedJobs;
    setDecision(
      `当前 ${strong.length} 个 ≥75 分岗位，目标 ${target} 个。` +
        (strong.length >= target ? '已达到目标。' : '低于目标（V0.4 Phase4 将自动 Replan 一次）。'),
    );
    addActivity('Evaluate', `目标 ${target}，当前 ${strong.length}`);

    // 8) Shortlist
    renderShortlist(strong);
    showState('complete');
    $('stateText').textContent = 'complete';
  } catch (e) {
    stop(`BOSS 页面需要人工处理，请完成后重新开始。\n原因：${e?.message ?? e}`);
  }
}

function renderShortlist(strong) {
  const sorted = [...strong].sort((a, b) => (b.__ai?.score ?? 0) - (a.__ai?.score ?? 0));
  session.shortlist = sorted;
  session.selectedIds = new Set();
  $('jobCards').innerHTML = sorted
    .map((j, i) => {
      const score = j.__ai?.score ?? 0;
      const tier = score >= 80 ? 'hot' : score >= 75 ? 'apply' : 'review';
      const strengths = (j.__ai?.strengths ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
      const concerns = (j.__ai?.concerns ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
      return `<div class="job-card" data-i="${i}">
        <div class="job-head">
          <input type="checkbox" data-job="${escapeHtml(j.jobId)}" />
          <div>
            <div class="job-title">${escapeHtml(j.title || j.name || '')}
              <span class="score-badge score-${tier}">${score} 分 · ${escapeHtml(j.__ai?.label ?? '')}</span>
            </div>
            <div class="job-meta">${escapeHtml(j.company || '')} · ${escapeHtml(j.area || '')} · ${escapeHtml(j.asciiSalary || j.salaryRaw || '薪资未知')} · ${escapeHtml((j.expEdu ?? []).join('/'))}</div>
            <div class="job-why"><b>推荐理由：</b>${escapeHtml(j.__ai?.matchedNote ?? '')}</div>
            ${strengths ? `<div class="job-why"><b>优势</b><ul>${strengths}</ul></div>` : ''}
            ${concerns ? `<div class="job-why"><b>顾虑</b><ul>${concerns}</ul></div>` : ''}
            <div class="job-actions"><a href="https://www.zhipin.com${escapeHtml(j.href)}" target="_blank">打开岗位</a></div>
          </div>
        </div>
      </div>`;
    })
    .join('');
  for (const cb of document.querySelectorAll('#jobCards input[type="checkbox"]')) {
    cb.onchange = () => {
      const id = cb.dataset.job;
      if (cb.checked) session.selectedIds.add(id);
      else session.selectedIds.delete(id);
      cb.closest('.job-card').classList.toggle('selected', cb.checked);
      $('selectedCount').textContent = String(session.selectedIds.size);
    };
  }
  $('selectedCount').textContent = '0';
}

// ---------------- 连接状态 / 配额 ----------------
async function checkBoss() {
  const ok = (await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] })).length > 0;
  const b = $('bossBadge');
  b.textContent = ok ? 'BOSS 已连接' : 'BOSS 未连接';
  b.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
  return ok;
}

async function checkAi() {
  const b = $('aiBadge');
  try {
    const ok = (await fetch(`${AI_BASE}/health`, { signal: AbortSignal.timeout(AI_TIMEOUT) })).ok;
    b.textContent = ok ? 'AI 服务已连接' : 'AI 服务异常';
    b.className = `badge ${ok ? 'badge-ok' : 'badge-bad'}`;
    return ok;
  } catch {
    b.textContent = 'AI 服务未连接';
    b.className = 'badge badge-idle';
    return false;
  }
}

export async function refreshQuota() {
  const cap = Number($('capInput').value) || 5;
  await chrome.storage.local.set({ dailyCap: cap });
  const key = `greet-${todayKey()}`;
  const st = await chrome.storage.local.get(key);
  const done = Number(st[key] ?? 0);
  $('quotaText').textContent = `${done} / ${cap}`;
  $('approveQuota').textContent = `${done} / ${cap}`;
  $('approveCap').textContent = String(cap);
}

const DEFAULT_GREET =
  '您好，我有5年产品经理经验、其中2年专注AI方向，主导过智能客服、知识库问答等产品0-1落地，熟悉大模型应用与Agent工作流，希望进一步交流，谢谢。';

async function loadGreetText() {
  const st = await chrome.storage.local.get('greetText');
  $('greetText').value = st.greetText ?? DEFAULT_GREET;
}

// ---------------- 事件绑定 ----------------
async function onStart() {
  const goal = $('goalInput').value.trim();
  const err = $('idleError');
  err.hidden = true;
  if (!goal) {
    err.textContent = '请先描述你的求职目标。';
    err.hidden = false;
    return;
  }
  session.activity = [];
  session.stopped = false;
  session.replanCount = 0;
  session.searchedQueries = [];
  session.discoveredJobs = [];
  session.detailJobs = [];
  session.scoredJobs = [];
  showState('running');
  addActivity('Planning', '收到目标，正在生成搜索计划');
  await runAgent(goal);
}

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
    if (!session.selectedIds.size) {
      $('completeError').hidden = false;
      $('completeError').textContent = '请先勾选要联系的岗位。';
      return;
    }
    $('approveBox').hidden = false;
    $('approveCount').textContent = String(session.selectedIds.size);
  };
  $('cancelApprove').onclick = () => {
    $('approveBox').hidden = true;
  };
  $('approveBtn').onclick = async () => {
    session.approved = true;
    await chrome.storage.local.set({ greetText: $('greetText').value });
    $('completeError').hidden = false;
    $('completeError').textContent = '打招呼流程将在 Phase 5 接入（需要用户批准 + 每日上限 + 历史去重）。';
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

export { AI_BASE, todayKey, checkBoss, checkAi, findBossTab, gotoSearch, fetchDetail };
