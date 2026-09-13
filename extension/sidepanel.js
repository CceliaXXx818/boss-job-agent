// sidepanel.js —— Job Agent 主界面（ES module）
// 原则：LLM 决定 WHAT（Plan/Replan），core-logic 决定规则允许范围，content.js 决定 HOW（DOM 动作）。
import {
  resolveBossContext,
  detectCityConflict,
  canGreet,
  mergeHardExclusions,
  hardFilter,
  selectDetailTargets,
  rankJobs,
  shouldReplan,
  applyReplanQueries,
  MAX_REPLAN,
  hhmm,
} from './core-logic.js';
import {
  MODES,
  DEFAULT_GREETING_TEMPLATE,
  MAX_GREETING_TEMPLATE_LENGTH,
  loadSettings,
  saveSettings,
  recordAutopilotConsent,
  revokeAutopilotConsent,
  isWithinWorkingHours,
} from './settings.js';
import { buildGreetingMessage } from './greeting-builder.js';
import { evaluateAutopilotGreeting } from './autopilot-policy.js';
// ---- V0.5 Phase 2：持久化层（Event Store / Job State / Action Queue）----
import { aggregateEvents, getEventMeta, localDateKey, pruneEvents } from './event-store.js';
import { countByState, getAllJobStates } from './job-state.js';
import {
  ACTION_STATUS,
  approveActions,
  createGreetingActions,
  getActions,
  markExecuting,
  markFailed,
  markSkipped,
  markSuccess,
  pruneActions,
  recoverInterruptedActions,
  summarizeActions,
} from './action-queue.js';
import {
  getDailyGreetingCount,
  getGreetedHistory,
  hasGreeted,
  recordConsent,
  recordGreetingFailure,
  recordGreetingSuccess,
  recordJobsDiscovered,
  recordJobsScored,
  recordJobsShortlisted,
  recordModeChange,
  recordSettingsUpdated,
} from './agent-records.js';

const AI_BASE = 'http://127.0.0.1:8799';
const AI_TIMEOUT = 3000;
const DETAIL_LIMIT = 15;

const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const session = {
  state: 'idle',
  settings: null,
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
  stagedActions: [],
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
  const rows = [];
  rows.push(`<li><span>城市（当前 BOSS）</span><b>${escapeHtml(goal.cities.map((c) => c.name).join('、') || '—')}</b></li>`);
  const direction = [...goal.targetTitles, ...goal.preferredSkills].filter(Boolean);
  if (direction.length) rows.push(`<li><span>方向</span><b>${escapeHtml(direction.join(' / '))}</b></li>`);
  rows.push(`<li><span>薪资要求</span><b>${goal.salaryMinK ? `${goal.salaryMinK}K+` : '不限'}</b></li>`);
  if (goal.hardExclusions?.length) {
    rows.push(`<li><span>明确排除</span><b>${goal.hardExclusions.map((t) => `× ${escapeHtml(t)}`).join('　')}</b></li>`);
  }
  if (goal.softNegativePreferences?.length) {
    rows.push(`<li><span>偏弱偏好</span><b>${goal.softNegativePreferences.map((t) => `△ ${escapeHtml(t)}`).join('　')}</b></li>`);
  }
  $('goalSummary').innerHTML = rows.join('');
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
// ---------------- V0.4.1 Browser Context：当前 BOSS 城市 ----------------
async function getCurrentBossContext() {
  const badge = $('cityBadge');
  let ctx = null;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });
    // 优先当前激活的 BOSS 标签（用户刚切完城市的那一个），其次岗位列表页
    const ordered = [
      ...tabs.filter((t) => t.active),
      ...tabs.filter((t) => /\/web\/geek\//.test(t.url)),
      ...tabs,
    ].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
    for (const tab of ordered) {
      try {
        const page = await chrome.tabs.sendMessage(tab.id, { type: 'bossContext' });
        const parsed = resolveBossContext(page);
        if (parsed) {
          ctx = parsed;
          break;
        }
      } catch { /* 该标签 content script 未就绪，试下一个 */ }
    }
  } catch { /* 页面未就绪 */ }
  if (ctx) {
    session.bossContext = ctx;
    badge.textContent = `📍 当前城市：${ctx.cityName}`;
    badge.className = 'badge badge-ok';
    badge.title = `code=${ctx.cityCode || '未知'} · 页面=${ctx.pageType} · ${ctx.url}`;
    session.bossContext = ctx;
  } else {
    session.bossContext = null;
    badge.textContent = '📍 当前城市：未识别';
    badge.className = 'badge badge-bad';
  }
  return ctx;
}

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
    // 0) Browser Context：每次开始都重新读取当前 BOSS 城市（不使用旧缓存）
    const bossContext = await getCurrentBossContext();
    if (!bossContext) {
      throw new Error('无法识别当前 BOSS 城市，请先打开 BOSS 岗位列表页并选择城市后重新开始。');
    }
    if (bossContext.cityCode && bossContext.cityName === `城市${bossContext.cityCode}`) {
      addActivity('Context', `已读取当前城市 code=${bossContext.cityCode}（页面未识别到城市名）`);
    } else {
      addActivity('Context', `当前 BOSS 城市：${bossContext.cityName}（${bossContext.cityCode || '无 code'}）`);
    }

    // 1) Plan
    $('stateText').textContent = 'planning';
    const planRes = await fetch(`${AI_BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: rawGoal, context: { cityName: bossContext.cityName, cityCode: bossContext.cityCode } }),
      signal: AbortSignal.timeout(60000),
    }).then((r) => r.json());
    if (!planRes?.ok) throw new Error(friendlyError(`规划失败：${planRes?.error ?? 'AI 服务未就绪（请先 npm run score:serve）'}`));
    let { goal, queries, warnings, successCriteria, mentionedCities } = planRes.plan;

    // 防御 A：服务端可能是旧进程 / 返回旧结构 → 强制以当前 Browser Context 为准
    if (!bossContext.cityCode) {
      throw new Error('无法获取当前城市 code，请在 BOSS 岗位列表页选择城市后再开始。');
    }
    const planCity = goal.cities?.[0];
    if (!planCity || planCity.code !== bossContext.cityCode) {
      const keywords = [...new Set((queries ?? []).map((q) => q.keyword))].slice(0, 6);
      addActivity(
        'Context',
        `计划城市为 ${planCity?.name ?? '未知'}，与当前 BOSS 城市 ${bossContext.cityName} 不一致，已按当前城市重建 ${keywords.length} 个搜索任务`,
      );
      goal = { ...goal, cities: [{ name: bossContext.cityName, code: bossContext.cityCode }] };
      queries = keywords.map((k) => ({ cityName: bossContext.cityName, cityCode: bossContext.cityCode, keyword: k, source: 'initial' }));
    }
    // 防御 B：兼容旧服务返回的字段名（excludeTokens → hardExclusions）
    goal.hardExclusions = goal.hardExclusions ?? goal.excludeTokens ?? [];
    goal.softNegativePreferences = goal.softNegativePreferences ?? [];
    // Case C：Goal 提到的城市与当前 BOSS 城市冲突 → 不自动切城市，直接停下并提示
    const conflict = detectCityConflict(mentionedCities, bossContext.cityName);
    if (conflict.conflict) {
      throw new Error(
        `当前 BOSS 城市为${bossContext.cityName}，但你的求职目标中提到了${conflict.others.join('、')}。` +
          `请先将 BOSS 切换到${conflict.others[0]}后重新开始。`,
      );
    }
    session.goal = goal;
    session.plan = { goal, queries, successCriteria };
    session.warnings = warnings ?? [];
    renderGoalSummary(goal);
    renderPlanList(queries);
    if (!queries.length) throw new Error('计划中没有可用的搜索任务（城市可能不受支持）');

    // 每日上限：Phase 2 起以用户设置为唯一事实来源（计划里的建议值只做提示）
    const cap = Number(session.settings?.dailyGreetingCap) || 5;
    const planCap = Number(goal.dailyGreetingCap);
    if (Number.isFinite(planCap) && planCap !== cap) {
      addActivity('Settings', `计划建议每日联系 ${planCap} 个，当前设置为 ${cap} 个（以设置为准，可在 Autopilot 设置里调整）`);
    }
    $('capInput').value = cap;
    await refreshQuota();

    // 2) 排除词 = 画像 + Goal（硬约束最高优先级）
    let candidateExclude = [];
    try {
      const cfg = await fetch(`${AI_BASE}/config`, { signal: AbortSignal.timeout(AI_TIMEOUT) }).then((r) => r.json());
      candidateExclude = cfg?.candidate?.hardExclusions ?? cfg?.candidate?.excludeTokens ?? [];
    } catch { /* 服务不可用时仅用 Goal 排除项 */ }
    const hardExclusions = mergeHardExclusions(candidateExclude, goal.hardExclusions);
    session.hardExclusions = hardExclusions;

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
    await safeRecord('Shortlisted', () =>
      recordJobsShortlisted({ jobs: strong, mode: session.settings?.mode ?? 'review' }),
    );
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
  // Phase 2：把候选岗位写入 Event Store（幂等，跨轮不会重复记录）+ Job State = DISCOVERED
  await safeRecord('Discovered', () =>
    recordJobsDiscovered({ jobs: qualified, round: session.replanCount + 1, mode: session.settings?.mode ?? 'review' }),
  );

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
          hardExclusions: session.goal.hardExclusions,
          softNegativePreferences: session.goal.softNegativePreferences,
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
    await safeRecord('Scored', () =>
      recordJobsScored({ jobs: newlyFetched, mode: session.settings?.mode ?? 'review' }),
    );
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

// ---------------- Phase 2：Review 打招呼 = Action Queue + Event Store ----------------
// 流程：勾选 → 创建 GREETING Actions(pending) → 二次确认(approved) → 执行 content.greetFull
//       → 成功：action success + GREETING_SENT + Job State GREETED
//       → 失败：action failed + GREETING_FAILED（绝不标成 GREETED）
// content.js 的 DOM 行为保持不变。

/** 记录类调用一律不阻断主流程：存储出问题只提示，不让整轮搜索失败 */
export async function safeRecord(label, fn) {
  try {
    return await fn();
  } catch (e) {
    addActivity(label, `记录失败（不影响本次运行）：${e?.message ?? e}`);
    return null;
  }
}

function selectedJobs() {
  return (session.shortlist ?? []).filter((j) => session.selectedIds.has(j.jobId));
}

/** 第一步：把选中岗位转成 pending Action（此时固化话术），并展示二次确认 */
async function stageGreetingActions() {
  const box = $('completeError');
  box.hidden = true;
  const selected = selectedJobs();
  if (!selected.length) {
    box.className = 'box box-error';
    box.textContent = '请先勾选要联系的岗位。';
    box.hidden = false;
    return;
  }

  // 话术固化：Review 输入框是编辑面，先写进 settings 再固化进 Action
  const typed = $('greetText').value;
  if (typed.trim() !== session.settings?.greetingStrategy?.template) {
    session.settings = await saveSettings({
      ...session.settings,
      greetingStrategy: { ...session.settings.greetingStrategy, mode: 'template', template: typed },
    });
    renderTemplateForm();
  }

  let built;
  try {
    built = buildGreetingMessage({
      job: { jobId: 'batch', title: `${selected.length} 个岗位` },
      greetingStrategy: session.settings.greetingStrategy,
    });
  } catch (e) {
    box.className = 'box box-error';
    box.textContent = `话术不可用：${e?.message ?? e}`;
    box.hidden = false;
    return;
  }

  const res = await createGreetingActions({
    jobs: selected.map((j) => ({
      jobId: j.jobId,
      title: j.title,
      company: j.company,
      href: j.href,
      score: j.__ai?.score ?? null,
    })),
    message: built.message,
    strategy: built.strategy,
    mode: session.settings?.mode ?? 'review',
  });
  session.stagedActions = res.created;

  const listEl = $('stagedActions');
  const createdHtml = res.created.length
    ? `<div>已创建 <b>${res.created.length}</b> 个待确认 Action（idempotencyKey = greeting:jobId）：</div>
       <ul class="staged-list">${res.created
         .map((a) => `<li>${escapeHtml(a.jobTitle ?? a.jobId)}（${a.payload.score ?? '—'} 分）</li>`)
         .join('')}</ul>`
    : '<div>没有可执行的 Action。</div>';
  const skippedHtml = res.skipped.length
    ? `<div class="policy-deny">跳过 ${res.skipped.length} 个：${res.skipped
        .map((s) => `${escapeHtml(s.jobId ?? '—')}（${escapeHtml(s.reason)}）`)
        .join('；')}</div>`
    : '';
  listEl.innerHTML = createdHtml + skippedHtml;

  $('approveCount').textContent = String(res.created.length);
  $('approveBox').hidden = false;
  await refreshQuota();
  await renderAgentStatePanel();
  addActivity(
    'ActionQueue',
    `已创建 ${res.created.length} 个 GREETING Action（pending），跳过 ${res.skipped.length} 个，等待你确认`,
  );
  if (!res.created.length) {
    box.className = 'box box-error';
    box.textContent = '选中的岗位都已联系过或已有待执行的 Action，没有需要执行的。';
    box.hidden = false;
  }
}

/** 第二步：用户确认 → approved → 逐条执行（失败不误标 GREETED） */
async function executeStagedActions() {
  const box = $('completeError');
  const actions = session.stagedActions ?? [];
  if (!actions.length) {
    box.className = 'box box-error';
    box.textContent = '没有待确认的 Action（请重新点击"联系选中岗位"）。';
    box.hidden = false;
    return;
  }

  const cap = Number(session.settings?.dailyGreetingCap) || 5;
  let done = (await getDailyGreetingCount()).effective;
  const tab = await findBossTab();

  const approval = await approveActions(actions.map((a) => a.actionId));
  const approvedIds = new Set(approval.approved.map((a) => a.actionId));
  for (const s of approval.skipped) addActivity('ActionQueue', `无法确认 ${s.actionId}：${s.reason}`);
  addActivity('Greeting', `用户已批准 ${approval.approved.length} 个 Action（今日 ${done}/${cap}）`);

  let sent = 0;
  let skipped = 0;
  const history = await getGreetedHistory();

  for (const action of actions) {
    if (!approvedIds.has(action.actionId)) {
      skipped++;
      continue;
    }

    // 执行前最终闸门：Event Store 幂等 + 每日上限 + 历史去重（防止重复点击/刷新/重开）
    if (await hasGreeted(action.jobId)) {
      await markSkipped(action.actionId, { reason: '该岗位已有 GREETING_SENT 记录' });
      skipped++;
      addActivity('Greeting', `跳过 ${action.jobTitle ?? action.jobId}：已有 GREETING_SENT 记录`);
      continue;
    }
    const gate = canGreet({ approved: true, dailyDone: done, dailyCap: cap, jobId: action.jobId, history });
    if (!gate.ok) {
      await markSkipped(action.actionId, { reason: gate.reason });
      skipped++;
      addActivity('Greeting', `跳过 ${action.jobTitle ?? action.jobId}：${gate.reason}`);
      continue;
    }

    await markExecuting(action.actionId);
    try {
      await chrome.tabs.update(tab.id, { url: `https://www.zhipin.com${action.payload.href}` });
      await sleep(4200);
      const r = await sendTab(tab.id, { type: 'greetFull', labels: GREET_LABELS, text: action.payload.message });
      const ok = r?.ok === true && (r.stage === 'sent' || r.stage === 'sent_by_enter');
      if (!ok) throw new Error(r?.detail ?? r?.stage ?? '打招呼未确认发送');

      // 统一 helper：append GREETING_SENT + Job State → GREETED + legacy 兼容写入
      const rec = await recordGreetingSuccess({
        job: { jobId: action.jobId, title: action.jobTitle, company: action.company },
        message: action.payload.message,
        messageStrategy: action.payload.messageStrategy,
        templateId: action.payload.templateId,
        score: action.payload.score,
        actionId: action.actionId,
        mode: action.mode,
      });
      await markSuccess(action.actionId, { eventId: rec.eventId });
      sent++;
      done++;
      history.add(action.jobId);
      session.selectedIds.delete(action.jobId);
      const job = (session.shortlist ?? []).find((j) => j.jobId === action.jobId);
      if (job) job.__greeted = true;
      addActivity('Greeting', `✓ ${action.jobTitle ?? action.jobId}（今日 ${done}/${cap}）`);
      await refreshQuota();
    } catch (e) {
      const friendly = friendlyError(e?.message ?? e);
      await safeRecord('GreetingFailed', () =>
        recordGreetingFailure({
          job: { jobId: action.jobId, title: action.jobTitle, company: action.company },
          error: friendly,
          actionId: action.actionId,
          mode: action.mode,
        }),
      );
      await markFailed(action.actionId, { error: friendly });
      box.hidden = false;
      box.className = 'box box-error';
      box.textContent = `该岗位未完成发送：${friendly}。Action 已标记为 failed，岗位状态不会变成 GREETED，请人工在 BOSS 页面处理后再重试。`;
      addActivity('Greeting', `失败：${action.jobTitle ?? action.jobId}（Action failed，未记 GREETED）`);
      session.stagedActions = [];
      await renderAgentStatePanel();
      return;
    }
  }

  box.hidden = false;
  box.className = 'box';
  box.textContent = `完成：成功 ${sent} 个，跳过 ${skipped} 个（今日 ${done}/${cap}）。`;
  addActivity('Greeting', `本轮结束：成功 ${sent}，跳过 ${skipped}`);
  // 已处理的 Action 不再留在暂存区：需要重试时必须重新走"联系选中岗位"（重新做幂等检查）
  session.stagedActions = [];
  await renderAgentStatePanel();
}

// ---------------- Phase 2：持久化状态面板（Side Panel 只是展示，storage 才是事实来源） ----------------
export async function renderAgentStatePanel() {
  const el = $('agentStateBody');
  if (!el) return;
  try {
    const today = localDateKey();
    const [queue, states, meta, recent, todayAgg] = await Promise.all([
      summarizeActions(),
      countByState(),
      getEventMeta(),
      getActions({}),
      aggregateEvents({ startDate: today, endDate: today }),
    ]);
    const stateLine = Object.entries(states)
      .map(([k, v]) => `<span class="state-chip">${escapeHtml(k)} ${v}</span>`)
      .join('') || '<span class="muted">（暂无岗位状态）</span>';
    const tail = recent.slice(-8).reverse();
    const actionLines = tail.length
      ? tail
          .map((a) => {
            const cls =
              a.status === ACTION_STATUS.SUCCESS
                ? 'ok'
                : a.status === ACTION_STATUS.FAILED || a.status === ACTION_STATUS.REQUIRES_MANUAL
                  ? 'bad'
                  : a.status === ACTION_STATUS.SKIPPED
                    ? 'warn'
                    : '';
            const extra = a.lastError ? ` — ${escapeHtml(a.lastError)}` : a.manualReason ? ` — ${escapeHtml(a.manualReason)}` : '';
            return `<div class="state-line"><span class="state-chip ${cls}">${a.status}</span>${escapeHtml(
              a.jobTitle ?? a.jobId,
            )}${extra}</div>`;
          })
          .join('')
      : '<div class="muted">（暂无 Action）</div>';
    const dates = Object.keys(meta.dates ?? {}).sort();
    const todayLine =
      `今日事件 ${todayAgg.total} 条：发现 ${todayAgg.discovered} · 评分 ${todayAgg.scored} · 入选 ${todayAgg.shortlisted}` +
      ` · 打招呼成功 ${todayAgg.greetingSent} · 失败 ${todayAgg.greetingFailed}`;
    el.innerHTML =
      `<div>${todayLine}</div>` +
      `<div><b>Action Queue</b>：待确认 ${queue.pending} · 已确认 ${queue.approved} · 执行中 ${queue.executing} · 成功 ${queue.success} · 失败 ${queue.failed} · 跳过 ${queue.skipped} · 需人工 ${queue.requiresManual}</div>` +
      `<div><b>岗位状态</b>：${stateLine}</div>` +
      `<div><b>事件</b>：共 ${meta.totalEvents ?? 0} 条，覆盖 ${dates.length} 天（保留 ${meta.retentionDays ?? 30} 天）；最近清理 ${
        meta.lastPrunedAt ? escapeHtml(String(meta.lastPrunedAt).slice(0, 19).replace('T', ' ')) : '从未'
      }</div>` +
      `<div><b>最近 Action</b>：</div>${actionLines}`;
  } catch (e) {
    el.textContent = `读取失败：${e?.message ?? e}`;
  }
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
  const cap = Number(session.settings?.dailyGreetingCap) || Number($('capInput').value) || 5;
  // 今日已联系数 = max(Event Store 里的 GREETING_SENT, V0.4 legacy 计数)，宁多算不少算
  let done = 0;
  try {
    done = (await getDailyGreetingCount()).effective;
  } catch {
    const key = `greet-${todayKey()}`;
    const st = await chrome.storage.local.get(key);
    done = Number(st[key] ?? 0) || 0;
  }
  $('quotaText').textContent = `${done} / ${cap}`;
  $('approveQuota').textContent = `${done} / ${cap}`;
  $('approveCap').textContent = String(cap);
}

// legacy 读取入口（V0.4 的 greetedHistory 继续兼容读取）
const getHistory = () => getGreetedHistory();

const GREET_LABELS = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '开始沟通', '打个招呼', '马上沟通', '立即开聊', '聊一聊', '发消息'];

const DEFAULT_GREET =
  '您好，我有5年产品经理经验、其中2年专注AI方向，主导过智能客服、知识库问答等产品0-1落地，熟悉大模型应用与Agent工作流，希望进一步交流，谢谢。';

async function loadGreetText() {
  const st = await chrome.storage.local.get('greetText');
  const tpl = session.settings?.greetingStrategy?.template;
  // 兼容旧版本：老用户只存过 greetText
  $('greetText').value = tpl ?? st.greetText ?? DEFAULT_GREETING_TEMPLATE;
}

// ---------------- V0.5 Phase 1：模式 / 设置 / 话术 / 授权 / Policy 试算 ----------------
function isAutopilot() {
  return session.settings?.mode === 'autopilot';
}

function renderModeUi() {
  const mode = session.settings?.mode ?? 'review';
  $('modeReview').checked = mode === 'review';
  $('modeAutopilot').checked = mode === 'autopilot';
  const box = $('autopilotState');
  box.hidden = false;
  if (mode === 'autopilot') {
    const ok = session.settings?.consent?.autopilot === true;
    box.className = 'small';
    box.innerHTML = ok
      ? '<span class="mode-badge on">Autopilot 已授权</span> 当前版本只做规则预演，自动搜索/自动打招呼在后续阶段开启。'
      : '<span class="mode-badge">未授权</span> 请重新选择 Autopilot 完成授权。';
  } else {
    box.className = 'muted small';
    box.textContent = '当前为 Review Mode：所有联系动作都需要你手动确认。';
  }
  $('policyPreviewBox').hidden = mode !== 'autopilot';
}

function fillSettingsForm() {
  const st = session.settings;
  if (!st) return;
  $('setMinScore').value = st.minimumAutoGreetingScore;
  $('setDailyCap').value = st.dailyGreetingCap;
  $('setBatchTarget').value = st.batchQualifiedTarget;
  $('setMaxRounds').value = st.maxDiscoveryRounds;
  $('setWorkStart').value = st.workingHours.start;
  $('setWorkEnd').value = st.workingHours.end;
  $('setMonitor').checked = st.monitorEnabled;
  $('setMonitorInterval').value = st.monitorIntervalMinutes;
  $('setDailyReport').checked = st.dailyReportEnabled;
  $('setReportTime').value = st.dailyReportTime;
  $('setEmailReport').checked = st.emailReportEnabled;
  $('setAutoResume').checked = false;
  $('capInput').value = st.dailyGreetingCap;
}

function readSettingsForm() {
  const base = session.settings;
  return {
    ...base,
    minimumAutoGreetingScore: Number($('setMinScore').value),
    dailyGreetingCap: Number($('setDailyCap').value),
    batchQualifiedTarget: Number($('setBatchTarget').value),
    maxDiscoveryRounds: Number($('setMaxRounds').value),
    workingHours: { start: $('setWorkStart').value.trim(), end: $('setWorkEnd').value.trim() },
    monitorEnabled: $('setMonitor').checked,
    monitorIntervalMinutes: Number($('setMonitorInterval').value),
    dailyReportEnabled: $('setDailyReport').checked,
    dailyReportTime: $('setReportTime').value.trim(),
    emailReportEnabled: $('setEmailReport').checked,
    autoSendResume: false,
  };
}

async function persistSettings(next, msgEl, okText) {
  const saved = await saveSettings(next);
  session.settings = saved;
  fillSettingsForm();
  await refreshQuota();
  if (msgEl) {
    msgEl.textContent = okText;
    setTimeout(() => { msgEl.textContent = ''; }, 2500);
  }
  return saved;
}

function renderTemplateForm() {
  const st = session.settings?.greetingStrategy;
  const tpl = st?.template ?? DEFAULT_GREETING_TEMPLATE;
  $('greetTemplate').value = tpl;
  $('greetText').value = tpl;
  $('strategyMode').value = st?.mode ?? 'template';
  updateTemplateCounter();
}

function updateTemplateCounter() {
  const len = $('greetTemplate').value.length;
  $('templateCounter').textContent = `${len} / ${MAX_GREETING_TEMPLATE_LENGTH}`;
  return len;
}

function previewTemplateOrThrow() {
  return buildGreetingMessage({
    job: { jobId: 'preview', title: '（示例岗位）', company: '（示例公司）' },
    greetingStrategy: { mode: 'template', templateId: 'preview', template: $('greetTemplate').value },
  }).message;
}

function openConsent() {
  let preview = '';
  let err = '';
  try {
    preview = previewTemplateOrThrow();
  } catch (e) {
    err = `话术不可用：${e?.message ?? e}`;
  }
  $('consentTemplatePreview').textContent = preview || '（话术为空，请先填写）';
  $('consentMsg').hidden = !err;
  $('consentMsg').textContent = err;
  $('consentAgree').disabled = Boolean(err);
  $('consentOverlay').hidden = false;
}

function closeConsent() {
  $('consentOverlay').hidden = true;
}

function revertModeRadio() {
  $('modeReview').checked = (session.settings?.mode ?? 'review') === 'review';
  $('modeAutopilot').checked = session.settings?.mode === 'autopilot';
}

async function setMode(mode) {
  if (!MODES.includes(mode)) return;
  if (mode === 'review') {
    const hadConsent = session.settings?.consent?.autopilot === true;
    const previous = session.settings?.mode ?? 'review';
    const next = hadConsent ? revokeAutopilotConsent(session.settings) : { ...session.settings, mode: 'review' };
    await persistSettings(next);
    await safeRecord('Mode', () => recordModeChange({ mode: 'review', previous }));
    if (hadConsent) await safeRecord('Consent', () => recordConsent({ granted: false, kind: 'autopilot' }));
    addActivity('Mode', hadConsent ? '已切回 Review Mode，并撤销 Autopilot 授权' : '已切换到 Review Mode（联系动作需手动确认）');
    renderModeUi();
    await renderAgentStatePanel();
    return;
  }
  // autopilot：首次开启必须先授权（后续再次切换不再重复弹窗）
  if (session.settings?.consent?.autopilot !== true) {
    openConsent();
    return;
  }
  const previous = session.settings?.mode ?? 'review';
  await persistSettings({ ...session.settings, mode: 'autopilot' });
  await safeRecord('Mode', () => recordModeChange({ mode: 'autopilot', previous }));
  addActivity('Mode', '已切换到 Autopilot（本阶段仅规则预演，不自动执行）');
  renderModeUi();
  await renderAgentStatePanel();
}

async function runPolicyPreview() {
  const out = $('policyPreviewResult');
  const shortlist = session.shortlist ?? [];
  if (!shortlist.length) {
    out.textContent = '当前没有 Shortlist，请先在 Review Mode 跑一轮搜索。';
    return;
  }
  const st = session.settings;
  const cap = st.dailyGreetingCap;
  const done = await safeRecord('Quota', () => getDailyGreetingCount()).then((r) => r?.effective ?? 0);
  const history = await getHistory();
  const nowHHMM = hhmm();
  const withinHours = isWithinWorkingHours(nowHHMM, st.workingHours.start, st.workingHours.end);
  let allowed = 0;
  const rows = shortlist
    .map((job) => {
      const d = evaluateAutopilotGreeting({
        settings: st,
        consent: st.consent,
        job: { jobId: job.jobId, score: job.__ai?.score ?? 0, complete: Boolean(job.jobId && job.href) },
        hardExclusionHit: { hit: false }, // 已通过硬过滤，进入 Shortlist 即未命中
        alreadyGreeted: history.has(job.jobId),
        dailyDone: done,
        nowHHMM,
        bossHealthy: true,
        captchaDetected: false,
        paused: false,
      });
      if (d.allowed) allowed++;
      return `<div class="policy-line ${d.allowed ? 'policy-allow' : 'policy-deny'}">${
        d.allowed ? '✓ 会联系' : '× 不会联系'
      } ${escapeHtml(job.title ?? job.jobId)}（${job.__ai?.score ?? 0}分）— ${escapeHtml(d.reason)}</div>`;
    })
    .join('');
  out.innerHTML =
    `<div><b>试算结果（未发送任何消息）</b>：会联系 ${allowed}，不会联系 ${shortlist.length - allowed}；` +
    `今日已联系 ${done}/${cap}；工作时间 ${st.workingHours.start}-${st.workingHours.end}` +
    `（当前 ${nowHHMM}，${withinHours ? '在工作时间内' : '不在工作时间内'}）</div>` +
    rows;
  addActivity('Policy', `Policy 试算：允许 ${allowed} / 拒绝 ${shortlist.length - allowed}（未执行任何动作）`);
}

function bindSettingsUi() {
  $('modeReview').onchange = () => setMode('review');
  $('modeAutopilot').onchange = () => setMode('autopilot');
  $('consentCancel').onclick = async () => {
    closeConsent();
    revertModeRadio();
  };
  $('consentEditTemplate').onclick = () => {
    closeConsent();
    $('greetingBox').open = true;
    $('greetTemplate').focus();
  };
  $('consentAgree').onclick = async () => {
    let preview;
    try {
      preview = previewTemplateOrThrow();
    } catch (e) {
      $('consentMsg').hidden = false;
      $('consentMsg').textContent = `话术不可用：${e?.message ?? e}`;
      return;
    }
    const withTpl = await saveSettings({
      ...session.settings,
      greetingStrategy: {
        ...session.settings.greetingStrategy,
        mode: 'template',
        template: $('greetTemplate').value,
      },
    });
    const recorded = recordAutopilotConsent(withTpl);
    const saved = await saveSettings({ ...recorded, mode: 'autopilot' });
    session.settings = saved;
    fillSettingsForm();
    renderTemplateForm();
    closeConsent();
    renderModeUi();
    await safeRecord('Consent', () => recordConsent({ granted: true, kind: 'autopilot', template: preview }));
    await renderAgentStatePanel();
    addActivity('Consent', `已授权 Autopilot（话术 ${preview.length} 字，可随时切回 Review 撤销运行）`);
  };
  $('saveSettings').onclick = async () => {
    const before = {
      minimumAutoGreetingScore: session.settings?.minimumAutoGreetingScore,
      dailyGreetingCap: session.settings?.dailyGreetingCap,
      workingHours: session.settings?.workingHours,
    };
    const next = readSettingsForm();
    await persistSettings(next, $('settingsMsg'), '已保存');
    renderModeUi();
    await safeRecord('Settings', () =>
      recordSettingsUpdated({
        changed: {
          minimumAutoGreetingScore: [before.minimumAutoGreetingScore, next.minimumAutoGreetingScore],
          dailyGreetingCap: [before.dailyGreetingCap, next.dailyGreetingCap],
          workingHours: [before.workingHours, next.workingHours],
        },
      }),
    );
    addActivity('Settings', `Autopilot 设置已更新（阈值 ${next.minimumAutoGreetingScore}，每日上限 ${next.dailyGreetingCap}）`);
    await renderAgentStatePanel();
  };
  $('greetTemplate').oninput = updateTemplateCounter;
  $('saveTemplate').onclick = async () => {
    const msg = $('templateMsg');
    try {
      const next = await saveSettings({
        ...session.settings,
        greetingStrategy: {
          ...session.settings.greetingStrategy,
          mode: 'template',
          template: $('greetTemplate').value,
        },
      });
      session.settings = next;
      $('greetText').value = next.greetingStrategy.template;
      await chrome.storage.local.set({ greetText: next.greetingStrategy.template });
      msg.textContent = '话术已保存';
      setTimeout(() => { msg.textContent = ''; }, 2500);
    } catch (e) {
      msg.textContent = e?.message ?? String(e);
    }
  };
  $('resetTemplate').onclick = async () => {
    const next = await saveSettings({
      ...session.settings,
      greetingStrategy: {
        ...session.settings.greetingStrategy,
        mode: 'template',
        template: DEFAULT_GREETING_TEMPLATE,
      },
    });
    session.settings = next;
    renderTemplateForm();
    $('templateMsg').textContent = '已恢复默认话术';
    setTimeout(() => { $('templateMsg').textContent = ''; }, 2500);
  };
  $('previewPolicy').onclick = () => {
    runPolicyPreview().catch((e) => {
      $('policyPreviewResult').textContent = `试算失败：${e?.message ?? e}`;
    });
  };
  $('refreshState').onclick = () => {
    renderAgentStatePanel().catch(() => {});
  };
  $('pruneEventsBtn').onclick = async () => {
    try {
      const r = await pruneEvents({ retentionDays: 30 });
      $('stateMsg').textContent = `已清理 ${r.removedDates.length} 天（${r.removedEvents} 条事件），保留副作用幂等键 ${r.keptCriticalKeys} 个`;
    } catch (e) {
      $('stateMsg').textContent = `清理失败：${e?.message ?? e}`;
    }
    await renderAgentStatePanel();
  };
  $('pruneActionsBtn').onclick = async () => {
    try {
      const r = await pruneActions({ retentionDays: 30 });
      $('stateMsg').textContent = `已清理 ${r.removed} 个旧 Action，保留 ${r.kept} 个`;
    } catch (e) {
      $('stateMsg').textContent = `清理失败：${e?.message ?? e}`;
    }
    await renderAgentStatePanel();
  };
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
  session.stagedActions = [];
  $('stagedActions').innerHTML = '';
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
  // Review 的运行上限与 Autopilot 每日上限共用同一份设置，避免出现两个"上限"
  $('capInput').onchange = async () => {
    const v = Number($('capInput').value) || 5;
    await persistSettings({ ...session.settings, dailyGreetingCap: v });
  };
  $('toApproveBtn').onclick = () => {
    stageGreetingActions().catch((e) => {
      $('completeError').hidden = false;
      $('completeError').className = 'box box-error';
      $('completeError').textContent = `创建 Action 失败：${e?.message ?? e}`;
    });
  };
  $('cancelApprove').onclick = async () => {
    $('approveBox').hidden = true;
    const staged = session.stagedActions ?? [];
    for (const a of staged) {
      await markSkipped(a.actionId, { reason: '用户在二次确认时取消' });
    }
    if (staged.length) addActivity('ActionQueue', `已取消 ${staged.length} 个待确认 Action（skipped）`);
    session.stagedActions = [];
    await renderAgentStatePanel();
  };
  $('approveBtn').onclick = async () => {
    $('completeError').hidden = true;
    $('approveBtn').disabled = true;
    try {
      await executeStagedActions();
    } catch (e) {
      $('completeError').hidden = false;
      $('completeError').className = 'box box-error';
      $('completeError').textContent = `执行失败：${e?.message ?? e}`;
    } finally {
      $('approveBtn').disabled = false;
    }
  };
}

let refreshTimer = null;
function scheduleContextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    getCurrentBossContext().catch(() => {});
  }, 700);
}

function bindContextWatchers() {
  try {
    chrome.tabs.onActivated.addListener(scheduleContextRefresh);
    chrome.tabs.onUpdated.addListener((_id, info, tab) => {
      if (!tab?.url?.includes('zhipin.com')) return;
      if (info.url || info.status === 'complete') scheduleContextRefresh();
    });
    chrome.windows?.onFocusChanged?.addListener(scheduleContextRefresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleContextRefresh();
    });
  } catch { /* 某些上下文可能不支持，忽略 */ }
}

async function init() {
  bind();
  bindContextWatchers();
  session.settings = await loadSettings();
  renderModeUi();
  fillSettingsForm();
  renderTemplateForm();
  bindSettingsUi();
  // Phase 2：上次运行中断在 executing 的 Action 需要人工确认（绝不自动重发）
  try {
    const recovered = await recoverInterruptedActions();
    if (recovered.count > 0) {
      addActivity('ActionQueue', `${recovered.count} 个 Action 上次执行中断，已标记为 requires_manual，请人工确认`);
      const box = $('idleError');
      box.hidden = false;
      box.className = 'box box-warn';
      box.textContent = `${recovered.count} 个 Action 在上次执行中被打断（可能是 Side Panel 关闭或页面刷新）。无法确定消息是否已发出，已标记为「需人工确认」，请到 BOSS 消息列表核对后再决定是否重试。`;
    }
  } catch (e) {
    addActivity('ActionQueue', `恢复中断 Action 失败：${e?.message ?? e}`);
  }
  await Promise.all([checkBoss(), checkAi()]);
  await getCurrentBossContext();
  await refreshQuota();
  await loadGreetText();
  await renderAgentStatePanel();
}

init();

export { AI_BASE, todayKey, isAutopilot, runPolicyPreview, setMode, stageGreetingActions, executeStagedActions, selectedJobs, checkBoss, checkAi, getCurrentBossContext, scheduleContextRefresh, findBossTab, gotoSearch, fetchDetail };
