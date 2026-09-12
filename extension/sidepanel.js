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
  allQueries: [],
  searchedQueries: [],
  discoveredMap: new Map(),
  discoveredJobs: [],
  qualifiedJobs: [],
  detailJobs: [],
  scoredJobs: [],
  fetchedDetailIds: new Set(),
  filteredOut: 0,
  excludeTokens: [],
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

export function friendlyError(msg) {
  const m = String(msg ?? '');
  if (/402|Insufficient Balance|欠费|余额不足/i.test(m)) {
    return 'DeepSeek 账户余额不足：请到 platform.deepseek.com 充值后重试（当前所有 AI 步骤都会失败）。';
  }
  if (/401|invalid_api_key|Unauthorized/i.test(m)) return 'API Key 无效或已过期：请检查 .env 中的 DEEPSEEK_API_KEY。';
  if (/timeout|aborted|ETIMEDOUT/i.test(m)) return 'AI 服务响应超时：请确认 npm run score:serve 正在运行且网络正常。';
  if (/Failed to fetch|ECONNREFUSED|NetworkError/i.test(m)) return '连不上本机 AI 服务：请先运行 npm run score:serve。';
  return m;
}

function setDecision(text) {
  $('decisionBox').textContent = text;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function setStats() {
  const analyzed = session.scoredJobs.filter((j) => j.__ai?.ok).length;
  $('statFound').textContent = String(session.discoveredJobs.length);
  $('statPassed').textContent = String(session.qualifiedJobs?.length ?? 0);
  $('statAnalyzed').textContent = String(analyzed);
  $('statRecommended').textContent = String(strongMatches().length);
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
        `<li data-i="${i}"><span>${escapeHtml(q.cityName)} · ${escapeHtml(q.keyword)}${q.source === 'replan' ? '（Replan）' : ''}</span>` +
        `<span class="status status-${q.status ?? 'waiting'}" data-status="${i}">${q.status ?? 'waiting'}</span></li>`,
    )
    .join('');
  const total = session.allQueries?.length ?? 0;
  const done = session.allQueries?.filter((q) => q.status === 'done').length ?? 0;
  $('planProgress').textContent = `${done} / ${total}`;
}
function markPlan(i, status) {
  const q = session.allQueries?.[i];
  if (q) q.status = status;
  renderPlanList(session.allQueries ?? []);
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
    const planRes = await fetch(`${AI_BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: rawGoal }),
      signal: AbortSignal.timeout(60000),
    }).then((r) => r.json());
    if (!planRes?.ok) throw new Error(friendlyError(`规划失败：${planRes?.error ?? 'AI 服务未就绪（请先 npm run score:serve）'}`));
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
    session.excludeTokens = excludeTokens;

    // 3) 第一轮：Search → Filter → Detail → Score
    const tab = await findBossTab();
    session.allQueries = [...queries];
    renderPlanList(session.allQueries);
    await runRound(tab, queries, 0);
    if (session.stopped) return;

    // 4) Evaluate（不足则 Replan 一次，最多一次）
    const firstEval = evaluate();
    if (!firstEval.enough && session.replanCount < MAX_REPLAN && !session.stopped) {
      $('stateText').textContent = 'replanning';
      addActivity('Replan', '正在评估是否需要补充搜索词');
      const replanRes = await fetch(`${AI_BASE}/replan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          searchedQueries: session.searchedQueries,
          resultSummary: buildResultSummary(),
          replanCount: session.replanCount,
        }),
        signal: AbortSignal.timeout(90000),
      }).then((r) => r.json());
      if (replanRes?.ok && replanRes.status === 'continue' && (replanRes.newQueries ?? []).length) {
        session.replanCount += 1;
        addActivity('Replan', `${replanRes.reason}｜新增：${replanRes.newQueries.map((q) => q.keyword).join('、')}`);
        setDecision(replanRes.reason);
        const base = session.allQueries.length;
        session.allQueries = [...session.allQueries, ...replanRes.newQueries];
        renderPlanList(session.allQueries);
        await runRound(tab, replanRes.newQueries, base);
        if (session.stopped) return;
        evaluate({ afterReplan: true });
      } else {
        addActivity('Replan', `无需补充：${replanRes?.reason ?? '本轮结束'}`);
        setDecision(replanRes?.reason ?? firstEval.text);
      }
    }

    // 5) Shortlist
    const strong = strongMatches();
    renderShortlist(strong);
    showState('complete');
    $('stateText').textContent = 'complete';
  } catch (e) {
    stop(`已停止。\n原因：${friendlyError(e?.message ?? e)}`);
  }
}

// ---------------- Round：Search → Filter → Detail → Score ----------------
async function runRound(tab, queries, planBaseIndex) {
  $('stateText').textContent = 'searching';
  for (let i = 0; i < queries.length; i++) {
    if (session.stopped) return;
    const q = queries[i];
    markPlan(planBaseIndex + i, 'running');
    const res = await gotoSearch(tab.id, q);
    let added = 0;
    for (const row of res.rows) {
      if (!session.discoveredMap.has(row.jobId)) {
        session.discoveredMap.set(row.jobId, { ...row, fromQuery: `${q.cityName}·${q.keyword}` });
        added++;
      }
    }
    session.searchedQueries.push(q);
    addActivity('Search', `${q.cityName} · ${q.keyword}：发现 ${res.count} 个岗位（新增 ${added}）`);
    markPlan(planBaseIndex + i, 'done');
  }
  session.discoveredJobs = [...session.discoveredMap.values()];
  setStats();

  // Filter（规则优先级高于任何模型分数）
  $('stateText').textContent = 'filtering';
  const passedIds = new Set(session.qualifiedJobs.map((j) => j.jobId));
  const qualified = [];
  let removedThisRound = 0;
  for (const j of session.discoveredJobs) {
    const r = hardFilter(j, session.excludeTokens);
    if (r.pass) qualified.push(j);
    else if (!passedIds.has(j.jobId)) removedThisRound++;
  }
  session.filteredOut += removedThisRound;
  session.qualifiedJobs = qualified;
  addActivity('Filter', `本轮移除 ${removedThisRound} 个（命中排除词），累计保留 ${qualified.length} 个`);
  setStats();

  // Detail（只抓 Top N 且未抓过的）
  $('stateText').textContent = 'fetching_details';
  const targets = selectDetailTargets(qualified, session.fetchedDetailIds, DETAIL_LIMIT);
  if (!targets.length) {
    addActivity('Detail', '没有需要新抓详情的岗位');
    return;
  }
  addActivity('Detail', `选取 ${targets.length} 个岗位抓详情（上限 ${DETAIL_LIMIT}）`);
  let consecutiveFail = 0;
  const newlyFetched = [];
  for (const job of targets) {
    if (session.stopped) return;
    try {
      const detail = await fetchDetail(tab.id, job);
      session.fetchedDetailIds.add(job.jobId);
      const merged = {
        ...job,
        ...detail,
        expEdu: detail?.expEdu?.length ? detail.expEdu : String(job.tags ?? '').split('|').filter(Boolean),
      };
      session.detailJobs.push(merged);
      newlyFetched.push(merged);
      consecutiveFail = 0;
    } catch (e) {
      consecutiveFail++;
      addActivity('Detail', `${job.title} 抓取失败：${e?.message ?? e}`);
      if (consecutiveFail >= 3) throw new Error('连续 3 个详情抓取失败，BOSS 页面可能需要人工处理');
    }
  }
  addActivity('Detail', `本轮详情完成 ${newlyFetched.length} / ${targets.length}`);

  // Score（只对新增详情调用，避免重复花费）
  if (newlyFetched.length) {
    $('stateText').textContent = 'scoring';
    const scoreRes = await fetch(`${AI_BASE}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobs: newlyFetched.map((j) => ({
          jobId: j.jobId,
          title: j.title || j.name || '',
          company: j.company || '',
          area: j.area || '',
          salaryAscii: j.asciiSalary || '',
          expEdu: j.expEdu || [],
          companyMeta: j.companyMeta || [],
          descFull: j.descFull || '',
        })),
        salaryMinK: session.goal.salaryMinK ?? undefined,
        goalContext: {
          cities: session.goal.cities.map((c) => c.name),
          salaryMinK: session.goal.salaryMinK,
          excludeTokens: session.goal.excludeTokens,
          targetTitles: session.goal.targetTitles,
          preferredSkills: session.goal.preferredSkills,
        },
      }),
      signal: AbortSignal.timeout(180000),
    }).then((r) => r.json());
    const byId = new Map((scoreRes?.results ?? []).map((r) => [r.jobId, r]));
    for (const j of newlyFetched) {
      const ai = byId.get(j.jobId);
      const idx = session.scoredJobs.findIndex((x) => x.jobId === j.jobId);
      const merged = { ...j, __ai: ai };
      if (idx >= 0) session.scoredJobs[idx] = merged;
      else session.scoredJobs.push(merged);
    }
    addActivity('Score', `本轮评分 ${newlyFetched.length} 个，≥75 分共 ${strongMatches().length} 个`);
  }
  setStats();
}

function strongMatches() {
  return session.scoredJobs.filter((j) => j.__ai?.ok && j.__ai.score >= 75);
}

function buildResultSummary() {
  return {
    discoveredCount: session.discoveredJobs.length,
    qualifiedCount: session.qualifiedJobs.length,
    strongMatchCount: strongMatches().length,
    topTitles: session.qualifiedJobs.map((j) => j.title).slice(0, 8),
    rejectedReasons: [`命中排除词后累计移除 ${session.filteredOut} 个`],
  };
}

function evaluate({ afterReplan = false } = {}) {
  $('stateText').textContent = 'evaluating';
  const target = session.plan?.successCriteria?.targetQualifiedJobs ?? 10;
  const strong = strongMatches().length;
  const enough = strong >= target;
  const text = enough
    ? `当前 ${strong} 个 ≥75 分岗位，达到目标 ${target} 个，进入 Shortlist。`
    : afterReplan
      ? `补充搜索后共 ${strong} 个 ≥75 分岗位，仍低于目标 ${target} 个；已达 Replan 上限（最多 1 次），本轮结束。`
      : `当前仅找到 ${strong} 个 ≥75 分岗位，低于目标 ${target} 个。`;
  setDecision(text);
  addActivity('Evaluate', `目标 ${target}，当前 ${strong}`);
  return { enough, strong, target, text };
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
  renderAgentSummary(sorted);
}

function renderAgentSummary(shortlist) {
  const target = session.plan?.successCriteria?.targetQualifiedJobs ?? 10;
  const strong = strongMatches().length;
  const replanHad = session.replanCount > 0;
  const replanQueries = (session.allQueries ?? []).filter((q) => q.source === 'replan');
  const top = (shortlist ?? []).slice(0, 3).map((j) => `${j.title}（${j.__ai?.score}分）`).join('、') || '无';
  const lines = [
    `<b>目标</b>：${escapeHtml(session.goal?.rawGoal ?? '')}`,
    `<b>结果</b>：Found ${session.discoveredJobs.length} → Passed Filters ${session.qualifiedJobs.length} → AI Analyzed ${session.scoredJobs.filter((j) => j.__ai?.ok).length} → Recommended ${strong}`,
    `<b>目标达成</b>：${strong >= target ? `是（${strong} / ${target}）` : `否（${strong} / ${target}，已达 Replan 上限）`}`,
    replanHad
      ? `<span class="replan">Replan ×${session.replanCount}</span>：新增 ${replanQueries.map((q) => escapeHtml(q.keyword)).join('、')}`
      : '未触发 Replan（首轮即达标）',
    `<b>推荐优先</b>：${escapeHtml(top)}`,
  ];
  $('agentSummaryBody').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

// ---------------- Phase 5：用户批准后的打招呼（复用 content.js greetFull） ----------------
async function greetSelected() {
  const text = $('greetText').value.trim();
  const cap = Number($('capInput').value) || 5;
  const key = `greet-${todayKey()}`;
  const st = await chrome.storage.local.get(key);
  let done = Number(st[key] ?? 0);
  const history = await getHistory();
  const selected = (session.shortlist ?? []).filter((j) => session.selectedIds.has(j.jobId));
  if (!selected.length) {
    $('completeError').hidden = false;
    $('completeError').textContent = '没有选中任何岗位。';
    return;
  }
  const tab = await findBossTab();
  addActivity('Greeting', `用户已批准：准备联系 ${selected.length} 个岗位（今日 ${done}/${cap}）`);
  let sent = 0;
  let skipped = 0;
  for (const job of selected) {
    // 三重闸门：用户批准 + 每日上限 + 历史去重（规则优先于任何模型判断）
    const gate = canGreet({ approved: true, dailyDone: done, dailyCap: cap, jobId: job.jobId, history });
    if (!gate.ok) {
      skipped++;
      addActivity('Greeting', `跳过 ${job.title}：${gate.reason}`);
      continue;
    }
    try {
      await chrome.tabs.update(tab.id, { url: `https://www.zhipin.com${job.href}` });
      await sleep(4200);
      const r = await sendTab(tab.id, { type: 'greetFull', labels: GREET_LABELS, text });
      const ok = r?.ok === true && (r.stage === 'sent' || r.stage === 'sent_by_enter');
      if (!ok) {
        addActivity('Greeting', `${job.title} 未完成发送：${r?.detail ?? r?.stage ?? '未知'}`);
        throw new Error('BOSS 页面需要人工处理（打招呼未确认发送）');
      }
      sent++;
      done++;
      await chrome.storage.local.set({ [key]: done });
      await addHistory(job.jobId);
      history.add(job.jobId);
      job.__greeted = true;
      addActivity('Greeting', `✓ ${job.title}（今日 ${done}/${cap}）`);
      await refreshQuota();
    } catch (e) {
      // 注意：打招呼失败不改变整体状态——保持在 COMPLETE，只在卡片区提示，
      // 避免把"已经跑完的搜索结果"整体丢掉。
      $('completeError').hidden = false;
      $('completeError').className = 'box box-error';
      $('completeError').textContent = `该岗位未完成发送：${friendlyError(e?.message ?? e)}。请人工在 BOSS 页面处理后再继续。`;
      addActivity('Greeting', `停止在本岗位（用户可人工处理后重试）`);
      return;
    }
  }
  $('completeError').hidden = false;
  $('completeError').className = 'box';
  $('completeError').textContent = `完成：成功 ${sent} 个，跳过 ${skipped} 个（今日 ${done}/${cap}）。`;
  addActivity('Greeting', `本轮结束：成功 ${sent}，跳过 ${skipped}`);
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

const HIST_KEY = 'greetedHistory';
async function getHistory() {
  const st = await chrome.storage.local.get(HIST_KEY);
  return new Set(Array.isArray(st[HIST_KEY]) ? st[HIST_KEY] : []);
}
async function addHistory(jobId) {
  const h = await getHistory();
  if (!h.has(jobId)) {
    h.add(jobId);
    await chrome.storage.local.set({ [HIST_KEY]: [...h] });
  }
}

const GREET_LABELS = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '开始沟通', '打个招呼', '马上沟通', '立即开聊', '聊一聊', '发消息'];

const DEFAULT_GREET =
  '您好，我有5年产品经理经验、其中2年专注AI方向，主导过智能客服、知识库问答等产品0-1落地，熟悉大模型应用与Agent工作流，希望进一步交流，谢谢。';

async function loadGreetText() {
  const st = await chrome.storage.local.get('greetText');
  $('greetText').value = st.greetText ?? DEFAULT_GREET;
}

// ---------------- 事件绑定 ----------------
function resetRunUi() {
  $('goalSummary').innerHTML = '';
  $('planList').innerHTML = '';
  $('planProgress').textContent = '';
  $('decisionBox').textContent = '等待规划…';
  $('statFound').textContent = '0';
  $('statPassed').textContent = '0';
  $('statAnalyzed').textContent = '0';
  $('statRecommended').textContent = '0';
  $('agentSummaryBody').textContent = '—';
  $('activityList').innerHTML = '';
  $('activityList2').innerHTML = '';
  $('approveBox').hidden = true;
  $('completeError').hidden = true;
  $('selectedCount').textContent = '0';
  $('stateText').textContent = '';
}

async function onStart() {
  const goal = $('goalInput').value.trim();
  const err = $('idleError');
  err.hidden = true;
  if (!goal) {
    err.textContent = '请先描述你的求职目标。';
    err.hidden = false;
    return;
  }
  resetRunUi();
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
    $('stateText').textContent = 'pausing…';
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
    $('completeError').hidden = true;
    $('approveBtn').disabled = true;
    try {
      await chrome.storage.local.set({ greetText: $('greetText').value });
      await greetSelected();
    } finally {
      $('approveBtn').disabled = false;
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

export { AI_BASE, todayKey, checkBoss, checkAi, findBossTab, gotoSearch, fetchDetail };
