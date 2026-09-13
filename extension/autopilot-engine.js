// autopilot-engine.js —— V0.5 Phase 3：Autopilot 事件驱动 Step Machine
//
// 铁律：
//   · 没有 while(true)、没有长驻 await、没有 setInterval；一个 tick 只推进一步。
//   · 状态只有一个来源：chrome.storage.local 里的 jobAgentAutopilotRuntime。
//   · 每个 step 结束后立即 persist；SW 被 suspend 不会丢进度。
//   · 所有副作用（浏览器 I/O、AI HTTP、时钟）都通过 deps 注入 → 可在 Node 里完整测试。
//
// 依赖注入（deps）：
//   browser: { getContext, ensureTab, search, detail, greet }
//   ai:      { checkHealth, planSearch, replanSearch, scoreJobs }
//   其余业务模块：settings / policy / greetingBuilder / queue / records / states / events / core
//   now(), onActivity(text)

import {
  AUTOPILOT_STATUS,
  AUTOPILOT_STEPS,
  RISK_REASONS,
  DETAIL_FETCH_LIMIT,
  MAX_ROUND_DISCOVERED,
  appendLog,
  emptyRoundStats,
  isActiveStatus,
  localDate,
  loadRuntime,
  patchRuntime,
  resetForNewDay,
  saveRuntime,
} from './autopilot-runtime.js';
import {
  buildGoalContext,
  buildScorePayload,
  checkHealth,
  getConfig,
} from './ai-client.js';
import {
  attachScores,
  buildResultSummary,
  decideReplanForCandidates,
  filterAutopilotEligible,
  buildSearchUrl,
  decideAfterRound,
  dedupeQueries,
  filterRound,
  mergeDetail,
  mergeReplanQueries,
  mergeSearchRows,
  pickDetailTargets,
  pickOutreachCandidates,
  resolveHardExclusions,
  strongMatches,
} from './discovery-runner.js';
import { detectCityConflict } from './core-logic.js';

export const ENGINE_VERSION = 1;
/** 同一 bounded 浏览器操作最多 1 次安全重试（V0.5 §31） */
export const MAX_SAFE_RETRY = 1;
/** 连续失败达到该值即 PAUSED（不是无限 retry） */
export const FAILURE_THRESHOLD = 2;
/** 一轮内最多创建多少条 Action（防止一次创建过多） */
export const MAX_ACTIONS_PER_ROUND = 20;
/**
 * 单次 /score 的批量大小。
 * 15 个岗位一次打分会让模型调用耗时接近 1 分钟，MV3 Service Worker 随时可能被回收；
 * 拆成小批可以让每个 tick 的工作更短、并把已得分数立即持久化（重试不重复付费）。
 */
export const SCORE_BATCH_SIZE = 5;

const DEFAULT_TARGET_QUALIFIED = 10;
const AI_UNAVAILABLE = RISK_REASONS.AI_SERVICE_UNAVAILABLE;
/** 距离工作时间结束不足这么多分钟时，启动会给出"本轮可能跑不完"的提醒 */
export const MIN_ROUND_WINDOW_MINUTES = 15;

/** 距离工作时间结束还剩多少分钟（支持跨夜窗口；不在窗口内返回 0） */
export function minutesUntilWindowEnd(nowHHMM, startHHMM, endHHMM) {
  const toMin = (v) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(v ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const now = toMin(nowHHMM);
  const start = toMin(startHHMM);
  const end = toMin(endHHMM);
  if (now === null || start === null || end === null) return null;
  if (start === end) return 24 * 60;
  const inside = start < end ? now >= start && now <= end : now >= start || now <= end;
  if (!inside) return 0;
  if (start < end) return end - now;
  // 跨夜窗口：已过 start（当天夜里）→ 跨到明天；在 start 之前（凌晨）→ 直接到今天 end
  return now >= start ? end + 24 * 60 - now : end - now;
}

/**
 * @param {{
 *   browser: object, ai: object, settings: object, policy: object, greeting: object,
 *   queue: object, records: object, states: object, events: object, core: object,
 *   now?: () => Date, onActivity?: (text: string) => void
 * }} deps
 */
export function createAutopilotEngine(deps) {
  const now = deps.now ?? (() => new Date());
  const activity = (text) => {
    try {
      deps.onActivity?.(text);
    } catch {
      /* activity 只是可读日志，失败不影响推进 */
    }
  };

  // ---------------- 启动前校验（V0.5 §10） ----------------

  /** @returns {Promise<{ok: boolean, code?: string, reason?: string, settings?: object, context?: object, todayGreetingCount?: number, capReached?: boolean}>} */
  async function validateStart() {
    const settings = await deps.settings.loadSettings();
    if (settings.mode !== 'autopilot') {
      return { ok: false, code: RISK_REASONS.MODE_INVALID, reason: '当前不是 Autopilot 模式' };
    }
    if (settings.consent?.autopilot !== true) {
      return { ok: false, code: RISK_REASONS.CONSENT_INVALID, reason: '尚未授权 Autopilot，请先完成授权' };
    }
    try {
      deps.greeting.buildGreetingMessage({
        job: { jobId: 'validate' },
        greetingStrategy: settings.greetingStrategy,
      });
    } catch (e) {
      return { ok: false, code: RISK_REASONS.TEMPLATE_INVALID, reason: `打招呼话术无效：${e?.message ?? e}` };
    }
    if (!deps.settings.isValidHHMM(settings.workingHours.start) || !deps.settings.isValidHHMM(settings.workingHours.end)) {
      return { ok: false, code: RISK_REASONS.SETTINGS_INVALID, reason: '工作时间设置不合法' };
    }
    if (!(Number(settings.dailyGreetingCap) >= 1)) {
      return { ok: false, code: RISK_REASONS.SETTINGS_INVALID, reason: '每日联系上限不合法' };
    }

    const context = await deps.browser.getContext();
    if (!context?.cityCode) {
      return {
        ok: false,
        code: RISK_REASONS.BROWSER_CONTEXT_INVALID,
        reason: '无法识别当前 BOSS 城市，请先打开 BOSS 岗位列表页并选择城市',
      };
    }

    // 今日额度已满：不需要工作时间的"现在"、也不需要 AI 服务，直接收工（V0.5 §12）
    const dailyEarly = await deps.records.getDailyGreetingCount(now());
    if (dailyEarly.effective >= settings.dailyGreetingCap) {
      return {
        ok: true,
        settings,
        context,
        todayGreetingCount: dailyEarly.effective,
        capReached: true,
      };
    }

    const inHours = deps.settings.isWithinWorkingHours(
      deps.core.hhmm(now()),
      settings.workingHours.start,
      settings.workingHours.end,
    );
    if (!inHours) {
      return {
        ok: false,
        code: RISK_REASONS.OUTSIDE_WORKING_HOURS,
        reason: `当前不在工作时间（${settings.workingHours.start}-${settings.workingHours.end}）`,
      };
    }

    const health = await deps.browser.health();
    if (health?.risk) {
      return { ok: false, code: health.risk, reason: health.reason ?? 'BOSS 页面需要人工处理' };
    }

    const ai = await deps.ai.checkHealth();
    if (!ai?.ok) {
      return { ok: false, code: RISK_REASONS.AI_SERVICE_UNAVAILABLE, reason: ai?.error ?? 'AI 服务不可用' };
    }

    return {
      ok: true,
      settings,
      context,
      todayGreetingCount: dailyEarly.effective,
      capReached: false,
    };
  }

  // ---------------- 启动 ----------------

  /**
   * @param {{rawGoal: string}} input
   * @returns {Promise<{ok: boolean, status?: string, reason?: string, code?: string, windowWarning?: string|null, runtime?: object}>}
   */
  async function startAutopilot({ rawGoal }) {
    const goal = String(rawGoal ?? '').trim();
    if (!goal) return { ok: false, code: 'NO_GOAL', reason: '请先输入求职目标' };

    const check = await validateStart();
    if (!check.ok) {
      await patchRuntime((rt) => ({ ...rt, lastError: check.reason }));
      return check;
    }
    const { settings, context, todayGreetingCount, capReached } = check;

    // 城市冲突在 PLAN 阶段用 planner 返回的 mentionedCities 精确判定（避免在这里猜城市名）
    const tab = await deps.browser.ensureTab(null);
    if (tab?.risk) {
      return { ok: false, code: tab.risk, reason: tab.reason ?? '无法建立 Autopilot 执行标签' };
    }

    const date = localDate(now());
    const started = await patchRuntime(() => ({
      sessionId: `ap_${now().getTime().toString(36)}`,
      date,
      status: capReached ? AUTOPILOT_STATUS.OUTREACH_COMPLETE : AUTOPILOT_STATUS.PLANNING,
      step: capReached ? AUTOPILOT_STEPS.FINISH : AUTOPILOT_STEPS.PLAN,
      rawGoal: goal,
      goal: null,
      browserContext: context,
      roundIndex: 1,
      maxDiscoveryRounds: settings.maxDiscoveryRounds,
      maxReplanPerRound: settings.maxReplanPerRound,
      batchQualifiedTarget: settings.batchQualifiedTarget,
      dailyGreetingCap: settings.dailyGreetingCap,
      minimumAutoGreetingScore: settings.minimumAutoGreetingScore,
      workingHours: settings.workingHours,
      currentPlan: null,
      searchedQueries: [],
      pendingQueries: [],
      currentQueryIndex: 0,
      replanCount: 0,
      currentRoundStats: emptyRoundStats(1),
      roundDiscovered: [],
      roundQualified: [],
      detailTargets: [],
      currentDetailIndex: 0,
      detailBuffer: [],
      scoredBuffer: [],
      recommendedJobIds: [],
      outreachQueue: [],
      actionsCreatedFor: [],
      seenJobIds: [],
      fetchedDetailIds: [],
      todayGreetingCount,
      activeActionId: null,
      paused: false,
      pauseReason: null,
      autopilotTabId: tab?.tabId ?? null,
      tabFailureCount: 0,
      consecutiveToolFailures: 0,
      lastRisk: null,
      startedAt: now().toISOString(),
      completedAt: null,
      lastError: null,
      cityConflictWarning: null,
      log: appendLog({ log: [] }, `Autopilot started｜城市 ${context.cityName}｜今日已联系 ${todayGreetingCount}/${settings.dailyGreetingCap}`),
    }));

    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.AUTOPILOT_STARTED,
      jobId: null,
      idempotencyKey: `autopilot-started:${started.sessionId}`,
      metadata: {
        sessionId: started.sessionId,
        date,
        city: context.cityName,
        cityCode: context.cityCode,
        dailyGreetingCap: settings.dailyGreetingCap,
        todayGreetingCount,
        maxDiscoveryRounds: settings.maxDiscoveryRounds,
      },
    });
    activity(`Autopilot started｜城市 ${context.cityName}｜今日已联系 ${todayGreetingCount}/${settings.dailyGreetingCap}`);

    // 提醒：离工作时间结束太近，本轮很可能跑不完（不改变执行规则，只提示）
    const remainMinutes = minutesUntilWindowEnd(
      deps.core.hhmm(now()),
      settings.workingHours.start,
      settings.workingHours.end,
    );
    let windowWarning = null;
    if (remainMinutes !== null && remainMinutes < MIN_ROUND_WINDOW_MINUTES) {
      windowWarning = `距离工作时间结束只剩 ${remainMinutes} 分钟（${settings.workingHours.start}-${settings.workingHours.end}），本轮搜索很可能无法跑完就会被自动收工；建议改到下一个工作日再启动。`;
      await patchRuntime((r) => ({ ...r, log: appendLog(r, `提醒：${windowWarning}`) }));
      activity(`提醒：${windowWarning}`);
    }

    if (capReached) {
      activity(`今日已达上限 ${settings.dailyGreetingCap}，不进入 Discovery，直接结束本轮 Outreach`);
      return {
        ok: true,
        status: AUTOPILOT_STATUS.OUTREACH_COMPLETE,
        reason: RISK_REASONS.DAILY_CAP_REACHED,
        windowWarning,
        runtime: started,
      };
    }
    return { ok: true, status: started.status, windowWarning, runtime: started };
  }

  // ---------------- 暂停 / 恢复 / 停止 ----------------

  /** @returns {Promise<{ok: boolean, status: string, reason: string}>} */
  async function pause(reason, code = null) {
    const rt = await patchRuntime((r) => ({
      ...r,
      status: AUTOPILOT_STATUS.PAUSED,
      paused: true,
      pauseReason: reason,
      lastRisk: code ?? reason,
      log: appendLog(r, `Autopilot paused：${reason}`),
    }));
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.AUTOPILOT_PAUSED,
      jobId: null,
      metadata: { reason, code: code ?? reason, activeActionId: rt.activeActionId, roundIndex: rt.roundIndex },
    });
    activity(`Autopilot paused：${reason}`);
    return { ok: true, status: rt.status, reason };
  }

  /** @returns {Promise<{ok: boolean, status?: string, reason?: string, code?: string}>} */
  async function resumeAutopilot() {
    const rt = await loadRuntime();
    if (rt.status !== AUTOPILOT_STATUS.PAUSED && rt.status !== AUTOPILOT_STATUS.ERROR) {
      return { ok: false, code: 'NOT_PAUSED', reason: '当前不是暂停状态，无需 Resume' };
    }
    // Resume 必须重新校验全部关键条件（V0.5 §28）
    const check = await validateStart();
    if (!check.ok) {
      await patchRuntime((r) => ({ ...r, lastError: check.reason, log: appendLog(r, `Resume 失败：${check.reason}`) }));
      return check;
    }
    if (check.capReached) {
      const done = await finishOutreach(`已达今日上限 ${check.settings.dailyGreetingCap}`, RISK_REASONS.DAILY_CAP_REACHED);
      return { ok: true, status: done.status, reason: RISK_REASONS.DAILY_CAP_REACHED };
    }
    const next = await patchRuntime((r) => ({
      ...r,
      status: r.currentPlan ? AUTOPILOT_STATUS.DISCOVERING : AUTOPILOT_STATUS.PLANNING,
      step: r.currentPlan ? r.step : AUTOPILOT_STEPS.PLAN,
      paused: false,
      pauseReason: null,
      lastError: null,
      dailyGreetingCap: check.settings.dailyGreetingCap,
      log: appendLog(r, 'Autopilot resumed'),
    }));
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.AUTOPILOT_RESUMED,
      metadata: { sessionId: next.sessionId, roundIndex: next.roundIndex, step: next.step },
    });
    activity('Autopilot resumed');
    return { ok: true, status: next.status };
  }

  /** @returns {Promise<{ok: boolean, status: string}>} */
  async function stopAutopilot() {
    const rt = await patchRuntime((r) => ({
      ...r,
      status: AUTOPILOT_STATUS.STOPPED,
      paused: true,
      pauseReason: RISK_REASONS.USER_PAUSED,
      log: appendLog(r, 'Autopilot stopped by user'),
    }));
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.AUTOPILOT_STOPPED,
      metadata: { sessionId: rt.sessionId, roundIndex: rt.roundIndex, todayGreetingCount: rt.todayGreetingCount },
    });
    activity('Autopilot stopped（今日 Events / Job State / Action 历史保留）');
    return { ok: true, status: rt.status };
  }

  async function pauseByUser() {
    return pause('用户暂停', RISK_REASONS.USER_PAUSED);
  }

  /** @returns {Promise<{ok: boolean, status: string, reason: string}>} */
  async function finishOutreach(reason, code) {
    const rt = await patchRuntime((r) => ({
      ...r,
      status: AUTOPILOT_STATUS.MONITORING,
      step: AUTOPILOT_STEPS.FINISH,
      paused: false,
      completedAt: now().toISOString(),
      log: appendLog(r, `Outreach completed：${reason}`),
    }));
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE,
      idempotencyKey: `outreach-complete:${rt.sessionId}`,
      metadata: {
        sessionId: rt.sessionId,
        reason,
        code: code ?? null,
        roundIndex: rt.roundIndex,
        todayGreetingCount: rt.todayGreetingCount,
      },
    });
    activity(`Outreach completed：${reason}｜今日已联系 ${rt.todayGreetingCount}/${rt.dailyGreetingCap}｜进入 MONITORING（下一阶段才真正监测 HR 回复）`);
    return { ok: true, status: rt.status, reason };
  }

  // ---------------- 单步执行器 ----------------

  /** 每个 step 的返回：{ nextStep, status, done } */
  async function stepPlan(rt) {
    const daily = await deps.records.getDailyGreetingCount(now());
    if (daily.effective >= rt.dailyGreetingCap) {
      return { nextStep: AUTOPILOT_STEPS.FINISH, status: AUTOPILOT_STATUS.OUTREACH_COMPLETE };
    }
    const res = await deps.ai.planSearch(rt.rawGoal, {
      cityName: rt.browserContext?.cityName,
      cityCode: rt.browserContext?.cityCode,
    });
    if (!res?.ok) {
      return { pause: res?.error ?? '规划失败（AI 服务未就绪）', code: RISK_REASONS.AI_SERVICE_UNAVAILABLE };
    }
    const plan = res.plan ?? {};
    let queries = plan.queries ?? [];
    const goal = plan.goal ?? null;
    if (!goal || !queries.length) {
      return { pause: '规划结果为空（没有可用的搜索任务）', code: RISK_REASONS.SETTINGS_INVALID };
    }
    const mentioned = res.plan?.mentionedCities ?? goal?.mentionedCities ?? [];
    const conflict = detectCityConflict(mentioned, rt.browserContext?.cityName);
    if (conflict.conflict) {
      return {
        pause: `求职目标中提到的城市（${conflict.others.join('、')}）与当前 BOSS 城市（${rt.browserContext?.cityName}）不一致，请先切换城市`,
        code: RISK_REASONS.BROWSER_CONTEXT_INVALID,
      };
    }
    // 城市以 Browser Context 为准（planner 不允许决定城市）
    queries = queries.map((q) => ({
      cityName: rt.browserContext.cityName,
      cityCode: rt.browserContext.cityCode,
      keyword: q.keyword,
      source: q.source ?? 'initial',
    }));
    const fresh = dedupeQueries(queries, rt.searchedQueries);

    const context = await promiseOr(() => deps.browser.getContext(), null);
    const hardExclusions = resolveHardExclusions(
      (await promiseOr(() => getConfig(), {}))?.candidate?.hardExclusions ?? [],
      goal.hardExclusions ?? [],
    );

    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.DISCOVERY_ROUND_STARTED,
      idempotencyKey: `round-started:${rt.sessionId}:${rt.roundIndex}`,
      metadata: { roundIndex: rt.roundIndex, queries: fresh.map((q) => q.keyword), city: rt.browserContext?.cityName },
    });
    activity(`Discovery Round ${rt.roundIndex} started｜搜索词：${fresh.map((q) => q.keyword).join('、')}`);

    return {
      patch: {
        status: AUTOPILOT_STATUS.DISCOVERING,
        goal,
        currentPlan: { goal, queries: fresh, successCriteria: plan.successCriteria ?? {} },
        pendingQueries: fresh,
        searchedQueries: rt.searchedQueries,
        currentQueryIndex: 0,
        replanCount: 0,
        hardExclusions,
        browserContext: context ?? rt.browserContext,
        currentRoundStats: {
          ...emptyRoundStats(rt.roundIndex),
          searchedQueries: [],
          roundTarget: Number(rt.batchQualifiedTarget) || 0,
        },
        roundDiscovered: [],
        roundQualified: [],
        detailTargets: [],
        currentDetailIndex: 0,
        detailBuffer: [],
        scoredBuffer: [],
        recommendedJobIds: [],
        eligibleJobIds: [],
        outreachQueue: [],
        actionsCreatedFor: [],
        log: appendLog(rt, `Discovery Round ${rt.roundIndex} started`),
      },
      nextStep: AUTOPILOT_STEPS.SEARCH_QUERY,
    };
  }

  async function stepSearchQuery(rt) {
    const queries = rt.currentPlan?.queries ?? [];
    if (rt.currentQueryIndex >= queries.length) {
      return { nextStep: AUTOPILOT_STEPS.FILTER };
    }
    const query = queries[rt.currentQueryIndex];
    const started = now().getTime();
    const res = await deps.browser.search(rt.autopilotTabId, query);
    if (res?.risk) return { pause: res.reason ?? 'BOSS 页面需要人工处理', code: res.risk };
    if (!res?.ok) {
      return {
        toolFailure: { step: AUTOPILOT_STEPS.SEARCH_QUERY, message: res?.error ?? '搜索失败' },
      };
    }
    const merged = mergeSearchRows(rt.roundDiscovered, res.rows ?? [], { fromQuery: `${query.cityName}·${query.keyword}` });
    const stats = {
      ...rt.currentRoundStats,
      searchedQueries: [...(rt.currentRoundStats?.searchedQueries ?? []), query.keyword],
      discoveredCount: merged.jobs.length,
      newDiscoveredCount: (rt.currentRoundStats?.newDiscoveredCount ?? 0) + merged.added,
    };
    activity(`Search: ${query.keyword}｜找到 ${res.rows?.length ?? 0} 个岗位（新增 ${merged.added}）｜耗时 ${Math.round((now().getTime() - started) / 1000)}s`);
    return {
      patch: {
        roundDiscovered: merged.jobs.slice(0, MAX_ROUND_DISCOVERED),
        currentQueryIndex: rt.currentQueryIndex + 1,
        searchedQueries: [...rt.searchedQueries, { ...query, round: rt.roundIndex }],
        currentRoundStats: stats,
        log: appendLog(rt, `Search ${query.keyword}：新增 ${merged.added}`),
      },
      nextStep: AUTOPILOT_STEPS.SEARCH_QUERY,
    };
  }

  async function stepFilter(rt) {
    const { qualified, removedCount } = filterRound(rt.roundDiscovered, {
      hardExclusions: rt.hardExclusions ?? [],
      seenJobIds: rt.seenJobIds ?? [],
    });
    const seen = new Set(rt.seenJobIds ?? []);
    for (const j of qualified) seen.add(j.jobId);
    const targets = pickDetailTargets(qualified, rt.fetchedDetailIds ?? [], DETAIL_FETCH_LIMIT);
    activity(`Filter：保留 ${qualified.length} 个（命中硬排除移除 ${removedCount} 个），选取 ${targets.length} 个抓详情`);

    if (qualified.length) {
      await deps.records.recordJobsDiscovered({
        jobs: qualified,
        round: rt.roundIndex,
        mode: 'autopilot',
        at: now(),
      });
    }
    const stats = {
      ...rt.currentRoundStats,
      filteredCount: qualified.length,
    };
    return {
      patch: {
        roundQualified: qualified,
        seenJobIds: [...seen],
        detailTargets: targets.map((j) => ({
          jobId: j.jobId,
          title: j.title ?? null,
          company: j.company ?? null,
          href: j.href ?? null,
          tags: j.tags ?? null,
        })),
        currentDetailIndex: 0,
        detailBuffer: [],
        currentRoundStats: stats,
        log: appendLog(rt, `Filter：保留 ${qualified.length}`),
      },
      nextStep: targets.length ? AUTOPILOT_STEPS.FETCH_DETAIL : AUTOPILOT_STEPS.SCORE,
    };
  }

  async function stepFetchDetail(rt) {
    const targets = rt.detailTargets ?? [];
    if (rt.currentDetailIndex >= targets.length) {
      return { nextStep: AUTOPILOT_STEPS.SCORE };
    }
    const job = targets[rt.currentDetailIndex];
    const res = await deps.browser.detail(rt.autopilotTabId, job);
    if (res?.risk) return { pause: res.reason ?? 'BOSS 页面需要人工处理', code: res.risk };
    if (!res?.ok) {
      return { toolFailure: { step: AUTOPILOT_STEPS.FETCH_DETAIL, message: res?.error ?? '详情抓取失败' } };
    }
    const full = mergeDetail(job, res.detail);
    return {
      patch: {
        detailBuffer: [...(rt.detailBuffer ?? []), full],
        fetchedDetailIds: [...(rt.fetchedDetailIds ?? []), job.jobId],
        currentDetailIndex: rt.currentDetailIndex + 1,
      },
      nextStep: AUTOPILOT_STEPS.FETCH_DETAIL,
    };
  }

  async function stepScore(rt) {
    const buffer = rt.detailBuffer ?? [];
    if (!buffer.length) {
      return { patch: { scoredBuffer: [] }, nextStep: AUTOPILOT_STEPS.EVALUATE };
    }
    // 只对"还没评过分"的岗位调用模型：SW 中途被回收 / 暂停后 Resume 时不会重复花钱
    const already = new Set((rt.scoredBuffer ?? []).map((j) => j.jobId));
    const pending = buffer.filter((j) => !already.has(j.jobId));
    if (!pending.length) {
      return { nextStep: AUTOPILOT_STEPS.EVALUATE };
    }

    const chunk = pending.slice(0, SCORE_BATCH_SIZE);
    const res = await deps.ai.scoreJobs({
      jobs: chunk.map((j) => buildScorePayload(j)),
      salaryMinK: rt.goal?.salaryMinK,
      goalContext: buildGoalContext(rt.goal ?? {}),
    });
    if (!res?.ok) {
      return {
        pause: `评分失败：${res?.error ?? 'AI 服务返回异常'}（已评 ${already.size} 个，剩余 ${pending.length} 个）`,
        code: AI_UNAVAILABLE,
      };
    }

    const scored = attachScores(chunk, res.results ?? []);
    await deps.records.recordJobsScored({ jobs: scored, mode: 'autopilot', at: now() });
    const merged = [...(rt.scoredBuffer ?? []).filter((j) => !chunk.some((c) => c.jobId === j.jobId)), ...scored];
    const counts = merged.filter((j) => j.__ai?.ok).length;
    const remaining = pending.length - chunk.length;
    activity(
      `Score：本批 ${scored.filter((j) => j.__ai?.ok).length} 个${remaining > 0 ? `（还有 ${remaining} 个待评）` : ''}，累计 ≥75 分 ${strongMatches(merged).length} 个`,
    );
    return {
      patch: {
        scoredBuffer: merged,
        currentRoundStats: { ...rt.currentRoundStats, analyzedCount: counts },
        log: appendLog(rt, `Score：本批 ${chunk.length} 个（累计 ${counts}）`),
      },
      nextStep: remaining > 0 ? AUTOPILOT_STEPS.SCORE : AUTOPILOT_STEPS.EVALUATE,
    };
  }

  async function stepEvaluate(rt) {
    // Recommended = AI 打分到推荐线（≥75）的岗位；只是"看起来匹配"
    const recommended = strongMatches(rt.scoredBuffer ?? []);
    // Autopilot Eligible = 满足自动联系静态条件的岗位（阈值 85 / 未硬排除 / 未联系过 / 信息完整 / 话术可用）
    const settings = await deps.settings.loadSettings();
    const history = await deps.records.getGreetedHistory();
    let greetingValid = true;
    try {
      deps.greeting.buildGreetingMessage({
        job: { jobId: 'evaluate' },
        greetingStrategy: settings.greetingStrategy,
      });
    } catch {
      greetingValid = false;
    }
    const { eligible, rejected } = filterAutopilotEligible(recommended, {
      minimumAutoGreetingScore: rt.minimumAutoGreetingScore ?? settings.minimumAutoGreetingScore,
      hardExclusions: rt.hardExclusions ?? [],
      greetedJobIds: [...history],
      greetingValid,
    });

    // 目标只认用户在设置里的 batchQualifiedTarget（不再使用 Planner 的 successCriteria.targetQualifiedJobs）
    const target = Number(rt.batchQualifiedTarget) || Number(settings.batchQualifiedTarget) || DEFAULT_TARGET_QUALIFIED;

    if (recommended.length) {
      await deps.records.recordJobsShortlisted({ jobs: recommended, mode: 'autopilot', at: now() });
    }

    // 三个概念都可观察：Recommended / Autopilot Eligible / Round Target
    activity(`Recommended ${recommended.length}`);
    activity(`Autopilot Eligible ${eligible.length} / Target ${target}`);
    if (rejected.length && !eligible.length) {
      activity(`→ 暂无可自动联系候选，示例原因：${rejected[0].reason}`);
    }

    const decision = decideReplanForCandidates({
      eligibleCount: eligible.length,
      targetCandidates: target,
      replanCount: rt.replanCount ?? 0,
      maxReplan: rt.maxReplanPerRound ?? 1,
    });
    activity(`→ ${decision.reason}`);

    const stats = {
      ...rt.currentRoundStats,
      recommendedCount: recommended.length,
      eligibleCount: eligible.length,
      roundTarget: target,
    };
    const patch = {
      recommendedJobIds: recommended.map((j) => j.jobId),
      eligibleJobIds: eligible.map((j) => j.jobId),
      currentRoundStats: stats,
      log: appendLog(
        rt,
        `Recommended ${recommended.length}｜Eligible ${eligible.length} / Target ${target}｜${decision.skipReplan ? 'skip Replan' : 'Replan'}`,
      ),
    };

    if (!decision.skipReplan) {
      return { patch, nextStep: AUTOPILOT_STEPS.REPLAN };
    }
    return { patch, nextStep: AUTOPILOT_STEPS.OUTREACH_CREATE };
  }

  async function stepReplan(rt) {
    const summary = buildResultSummary({
      discoveredCount: rt.roundDiscovered?.length ?? 0,
      qualifiedCount: rt.roundQualified?.length ?? 0,
      strongMatchCount: strongMatches(rt.scoredBuffer ?? []).length,
      topTitles: (rt.roundQualified ?? []).map((j) => j.title).slice(0, 8),
      filteredOut: rt.currentRoundStats?.filteredCount ?? 0,
    });
    const res = await deps.ai.replanSearch({
      goal: rt.goal,
      searchedQueries: rt.searchedQueries,
      resultSummary: summary,
      replanCount: rt.replanCount ?? 0,
    });
    if (!res?.ok) return { pause: res?.error ?? 'Replan 失败', code: RISK_REASONS.AI_SERVICE_UNAVAILABLE };
    if (res.status !== 'continue' || !(res.newQueries ?? []).length) {
      activity(`Replan：无需补充（${res.reason ?? '本轮结束'}）`);
      return {
        patch: { log: appendLog(rt, 'Replan：无需补充') },
        nextStep: AUTOPILOT_STEPS.OUTREACH_CREATE,
      };
    }
    // Replan 只允许新增 keyword：城市/硬约束/薪资下限/设置参数都不允许被 Replan 改动（V0.5 §14）
    const merged = mergeReplanQueries({
      existingQueries: rt.currentPlan?.queries ?? [],
      newQueries: res.newQueries,
      searchedQueries: rt.searchedQueries,
      cityCode: rt.browserContext?.cityCode,
      cityName: rt.browserContext?.cityName,
    });
    if (!merged.added.length) {
      activity('Replan：新增搜索词与今天已搜过的重复，直接进入 Outreach');
      return { patch: { log: appendLog(rt, 'Replan：无新增有效搜索词') }, nextStep: AUTOPILOT_STEPS.OUTREACH_CREATE };
    }
    activity(`Replan：新增搜索词 ${merged.added.map((q) => q.keyword).join('、')}`);
    return {
      patch: {
        currentPlan: { ...rt.currentPlan, queries: merged.queries },
        replanCount: (rt.replanCount ?? 0) + 1,
        currentRoundStats: { ...rt.currentRoundStats, replanCount: (rt.currentRoundStats?.replanCount ?? 0) + 1 },
        log: appendLog(rt, `Replan：新增 ${merged.added.length} 个搜索词`),
      },
      nextStep: AUTOPILOT_STEPS.SEARCH_QUERY,
    };
  }

  async function stepOutreachCreate(rt) {
    const daily = await deps.records.getDailyGreetingCount(now());
    const remaining = Math.max(0, rt.dailyGreetingCap - daily.effective);
    if (remaining <= 0) {
      activity(`今日已达上限 ${rt.dailyGreetingCap}，结束 Outreach`);
      return { nextStep: AUTOPILOT_STEPS.ROUND_END, patch: { todayGreetingCount: daily.effective, status: AUTOPILOT_STATUS.OUTREACH } };
    }

    const settings = await deps.settings.loadSettings();
    const history = await deps.records.getGreetedHistory();
    const alreadyGreeted = [...history];
    // 候选池 = Autopilot Eligible（静态条件已在 EVALUATE 阶段筛过；这里用最新数据重算一次）
    let greetingValid = true;
    try {
      deps.greeting.buildGreetingMessage({ job: { jobId: 'outreach' }, greetingStrategy: settings.greetingStrategy });
    } catch {
      greetingValid = false;
    }
    const recommended = strongMatches(rt.scoredBuffer ?? []);
    const { eligible } = filterAutopilotEligible(recommended, {
      minimumAutoGreetingScore: rt.minimumAutoGreetingScore ?? settings.minimumAutoGreetingScore,
      hardExclusions: rt.hardExclusions ?? [],
      greetedJobIds: alreadyGreeted,
      greetingValid,
    });
    // 注意：候选不做 cap 截断后再评估 —— 否则"超 cap 被拒"的原因会被隐藏。
    // 这里按单轮候选上限取候选，Policy 逐个判定，只把前 remaining 个放入队列。
    const budget = Math.min(remaining, MAX_ACTIONS_PER_ROUND);
    const candidates = pickOutreachCandidates(eligible, {
      remaining: Math.max(budget, MAX_ACTIONS_PER_ROUND),
      alreadyQueued: rt.actionsCreatedFor ?? [],
      alreadyGreeted,
    });
    if (!candidates.length) {
      activity('没有可进入 Action Queue 的新候选');
      return { nextStep: AUTOPILOT_STEPS.ROUND_END, patch: { todayGreetingCount: daily.effective, status: AUTOPILOT_STATUS.OUTREACH } };
    }

    // Policy 第一次校验（创建前）—— dailyDone 计入本批已计划的名额，绝不"先创建再发现超 cap"
    const planned = [];
    const denied = [];
    const health = await promiseOr(() => deps.browser.health(), { risk: null });
    for (const job of candidates) {
      if (planned.length >= budget) {
        denied.push({ job, reason: `已达今日上限 ${rt.dailyGreetingCap}` });
        continue;
      }
      const decision = deps.policy.evaluateAutopilotGreeting({
        settings,
        consent: settings.consent,
        job: { jobId: job.jobId, score: job.__ai?.score ?? 0, complete: Boolean(job.jobId && job.href) },
        hardExclusionHit: { hit: false },
        alreadyGreeted: alreadyGreeted.includes(job.jobId),
        dailyDone: daily.effective + planned.length,
        nowHHMM: deps.core.hhmm(now()),
        bossHealthy: !health?.risk,
        captchaDetected: health?.risk === RISK_REASONS.CAPTCHA,
        paused: false,
        templateValid: true,
      });
      if (decision.allowed) planned.push(job);
      else denied.push({ job, reason: decision.reason });
      if (health?.risk) break;
    }

    for (const d of denied) {
      await deps.events.appendEvent({
        type: deps.events.EVENT_TYPES.ACTION_SKIPPED,
        jobId: d.job.jobId,
        company: d.job.company ?? null,
        jobTitle: d.job.title ?? null,
        idempotencyKey: `policy-skip:${d.job.jobId}:${rt.date}`,
        metadata: { reason: d.reason, source: 'policy', phase: 'create', mode: 'autopilot' },
      });
    }

    if (!planned.length) {
      activity(`Policy 拒绝了本轮全部候选（例如：${denied[0]?.reason ?? '不满足条件'}）`);
      return {
        nextStep: AUTOPILOT_STEPS.ROUND_END,
        patch: {
          todayGreetingCount: daily.effective,
          actionsCreatedFor: [...(rt.actionsCreatedFor ?? []), ...denied.map((d) => d.job.jobId)],
          log: appendLog(rt, 'Policy 拒绝全部候选'),
        },
      };
    }

    let message;
    try {
      message = deps.greeting.buildGreetingMessage({
        job: { jobId: planned[0].jobId, title: planned[0].title },
        greetingStrategy: settings.greetingStrategy,
      });
    } catch (e) {
      return { pause: `打招呼话术无效：${e?.message ?? e}`, code: RISK_REASONS.TEMPLATE_INVALID };
    }

    const created = await deps.queue.createGreetingActions({
      jobs: planned.map((j) => ({
        jobId: j.jobId,
        title: j.title,
        company: j.company,
        href: j.href,
        score: j.__ai?.score ?? null,
      })),
      message: message.message,
      strategy: message.strategy,
      mode: 'autopilot',
      now: now(),
    });

    activity(`Autopilot approved ${created.created.length} 个 Action（Policy 通过 / 拒绝 ${denied.length}）`);
    return {
      patch: {
        outreachQueue: [...(rt.outreachQueue ?? []), ...created.created.map((a) => a.actionId)],
        actionsCreatedFor: [...(rt.actionsCreatedFor ?? []), ...created.created.map((a) => a.jobId), ...denied.map((d) => d.job.jobId)],
        status: AUTOPILOT_STATUS.OUTREACH,
        todayGreetingCount: daily.effective,
        log: appendLog(rt, `创建 ${created.created.length} 个 GREETING Action`),
      },
      nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE,
    };
  }

  async function stepOutreachExecute(rt) {
    const queueIds = rt.outreachQueue ?? [];
    if (!queueIds.length) return { nextStep: AUTOPILOT_STEPS.ROUND_END };

    const actionId = queueIds[0];
    const action = await deps.queue.getAction(actionId);
    const rest = queueIds.slice(1);
    if (!action) return { patch: { outreachQueue: rest }, nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE };

    // 已完成 / 已失败 / 需人工 → 出队继续
    if (['success', 'failed', 'skipped', 'requires_manual'].includes(action.status)) {
      return { patch: { outreachQueue: rest, activeActionId: null }, nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE };
    }

    if (action.status === deps.queue.ACTION_STATUS.PENDING) {
      // Policy 第二次校验（执行前）：daily count / working hours / pause / platform health 都可能已变化
      const settings = await deps.settings.loadSettings();
      const daily = await deps.records.getDailyGreetingCount(now());
      const health = await promiseOr(() => deps.browser.health(), { risk: null });
      const history = await deps.records.getGreetedHistory();
      const decision = deps.policy.evaluateAutopilotGreeting({
        settings,
        consent: settings.consent,
        job: { jobId: action.jobId, score: action.payload?.score ?? 0, complete: Boolean(action.jobId) },
        hardExclusionHit: { hit: false },
        alreadyGreeted: history.has(action.jobId),
        dailyDone: daily.effective,
        nowHHMM: deps.core.hhmm(now()),
        bossHealthy: !health?.risk,
        captchaDetected: health?.risk === RISK_REASONS.CAPTCHA,
        paused: false,
        templateValid: true,
      });
      if (!decision.allowed) {
        await deps.queue.markSkipped(actionId, { reason: decision.reason, now: now() });
        activity(`Autopilot 跳过 ${action.jobTitle ?? action.jobId}：${decision.reason}`);
        return {
          patch: { outreachQueue: rest, todayGreetingCount: daily.effective, log: appendLog(rt, `执行前 Policy 拒绝：${decision.reason}`) },
          nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE,
        };
      }
      await deps.queue.approveActions([actionId], { now: now() });
      return {
        patch: { activeActionId: actionId, todayGreetingCount: daily.effective },
        nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE,
      };
    }

    if (action.status === deps.queue.ACTION_STATUS.APPROVED) {
      await deps.queue.markExecuting(actionId, { now: now() });
      // 从这里到记录结果之间存在中断窗口：SW 如果在 greet 期间被杀，Action 会留在 executing，
      // 恢复时按保守原则标记 requires_manual（V0.5 §38），不会自动重发。
      const res = await deps.browser.greet(rt.autopilotTabId, action);
      if (res?.risk) {
        await deps.queue.markRequiresManual(actionId, { reason: `平台风险：${res.risk}`, now: now() });
        return { pause: res.reason ?? 'BOSS 页面需要人工处理', code: res.risk };
      }
      const daily = await deps.records.getDailyGreetingCount(now());
      if (res?.ok) {
        const rec = await deps.records.recordGreetingSuccess({
          job: { jobId: action.jobId, title: action.jobTitle, company: action.company },
          message: action.payload?.message,
          messageStrategy: action.payload?.messageStrategy,
          templateId: action.payload?.templateId,
          score: action.payload?.score ?? null,
          actionId,
          mode: 'autopilot',
          at: now(),
        });
        await deps.queue.markSuccess(actionId, { eventId: rec.eventId, now: now() });
        const after = await deps.records.getDailyGreetingCount(now());
        activity(`Greeting sent：${action.jobTitle ?? action.jobId}｜今日 ${after.effective}/${rt.dailyGreetingCap}`);
        return {
          patch: {
            outreachQueue: rest,
            activeActionId: null,
            todayGreetingCount: after.effective,
            log: appendLog(rt, `Greeting sent：${action.jobTitle ?? action.jobId}`),
          },
          nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE,
        };
      }
      await deps.records.recordGreetingFailure({
        job: { jobId: action.jobId, title: action.jobTitle, company: action.company },
        error: res?.error ?? '打招呼未确认发送',
        stage: res?.stage ?? null,
        actionId,
        mode: 'autopilot',
        at: now(),
      });
      await deps.queue.markFailed(actionId, { error: res?.error ?? '打招呼未确认发送', now: now() });
      activity(`Greeting failed：${action.jobTitle ?? action.jobId}（不会标记为 GREETED）`);
      return {
        patch: {
          outreachQueue: rest,
          activeActionId: null,
          todayGreetingCount: daily.effective,
          log: appendLog(rt, `Greeting failed：${action.jobTitle ?? action.jobId}`),
        },
        // 单次失败继续处理下一批；连续失败达到阈值会由 dispatcher 升级为 PAUSED
        toolFailure: { step: AUTOPILOT_STEPS.OUTREACH_EXECUTE, message: res?.error ?? '打招呼未确认发送' },
      };
    }

    // executing 等中间态：本次 tick 不重复动作，交给下次/恢复流程
    return { patch: { outreachQueue: rest, activeActionId: null }, nextStep: AUTOPILOT_STEPS.OUTREACH_EXECUTE };
  }

  async function stepRoundEnd(rt) {
    const daily = await deps.records.getDailyGreetingCount(now());
    const stats = { ...rt.currentRoundStats, roundIndex: rt.roundIndex };
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.DISCOVERY_ROUND_COMPLETED,
      idempotencyKey: `round-completed:${rt.sessionId}:${rt.roundIndex}`,
      metadata: { ...stats, city: rt.browserContext?.cityName ?? null },
    });
    activity(
      `Round ${rt.roundIndex} completed｜发现 ${stats.discoveredCount}｜过滤后 ${stats.filteredCount}｜评分 ${stats.analyzedCount}｜推荐 ${stats.recommendedCount}｜Replan ${stats.replanCount}`,
    );

    const winStart = rt.workingHours?.start ?? '09:00';
    const winEnd = rt.workingHours?.end ?? '18:00';
    const withinWorkingHours = deps.settings.isWithinWorkingHours(deps.core.hhmm(now()), winStart, winEnd);
    const decision = decideAfterRound({
      todayGreetingCount: daily.effective,
      dailyGreetingCap: rt.dailyGreetingCap,
      roundIndex: rt.roundIndex,
      maxDiscoveryRounds: rt.maxDiscoveryRounds,
      withinWorkingHours,
      roundHasNewCandidates: (stats.newDiscoveredCount ?? 0) > 0 && (stats.filteredCount ?? 0) > 0,
      // "有新的可继续搜索空间"= 本轮确实发现了新岗位；一个岗位都没新增说明搜索空间见底
      hasNewQueries: (stats.newDiscoveredCount ?? 0) > 0,
    });

    if (decision.action === 'COMPLETE') {
      const reason =
        decision.code === 'OUTSIDE_WORKING_HOURS'
          ? `${decision.reason}（当前本地时间 ${deps.core.hhmm(now())}，工作时间 ${winStart}-${winEnd}）`
          : decision.reason;
      return {
        patch: { todayGreetingCount: daily.effective },
        finish: { reason, code: decision.code },
      };
    }

    // 注意：这里不递增 roundIndex —— 只有当 NEXT_ROUND_PLAN 真的拿到了新搜索词、
    // 新一轮确实开始时才 +1，避免"空转一轮"被计入轮次。
    return {
      patch: {
        todayGreetingCount: daily.effective,
        roundDiscovered: [],
        roundQualified: [],
        detailTargets: [],
        currentDetailIndex: 0,
        detailBuffer: [],
        scoredBuffer: [],
        recommendedJobIds: [],
        eligibleJobIds: [],
        outreachQueue: [],
        actionsCreatedFor: [],
        replanCount: 0,
        currentQueryIndex: 0,
      },
      nextStep: AUTOPILOT_STEPS.NEXT_ROUND_PLAN,
    };
  }

  async function stepNextRoundPlan(rt) {
    const summary = buildResultSummary({
      discoveredCount: rt.roundDiscovered?.length ?? 0,
      qualifiedCount: rt.roundQualified?.length ?? 0,
      strongMatchCount: (rt.recommendedJobIds ?? []).length,
      topTitles: (rt.roundQualified ?? []).map((j) => j.title).slice(0, 8),
    });
    const res = await deps.ai.replanSearch({
      goal: rt.goal,
      searchedQueries: rt.searchedQueries,
      resultSummary: summary,
      replanCount: 0,
    });
    if (!res?.ok) return { pause: res?.error ?? '补充搜索计划失败', code: RISK_REASONS.AI_SERVICE_UNAVAILABLE };
    const merged = mergeReplanQueries({
      existingQueries: [],
      newQueries: res.newQueries ?? [],
      searchedQueries: rt.searchedQueries,
      cityCode: rt.browserContext?.cityCode,
      cityName: rt.browserContext?.cityName,
    });
    if (!merged.added.length) {
      return { finish: { reason: '无法产生新的搜索词（不会重复搜同一个关键词）', code: 'NO_NEW_RESULTS' } };
    }
    const nextRound = rt.roundIndex + 1;
    await deps.events.appendEvent({
      type: deps.events.EVENT_TYPES.DISCOVERY_ROUND_STARTED,
      idempotencyKey: `round-started:${rt.sessionId}:${nextRound}`,
      metadata: { roundIndex: nextRound, queries: merged.added.map((q) => q.keyword), city: rt.browserContext?.cityName },
    });
    activity(`Discovery Round ${nextRound} started｜搜索词：${merged.added.map((q) => q.keyword).join('、')}`);
    return {
      patch: {
        status: AUTOPILOT_STATUS.DISCOVERING,
        roundIndex: nextRound,
        currentRoundStats: emptyRoundStats(nextRound),
        currentPlan: { ...(rt.currentPlan ?? {}), queries: merged.added },
        currentQueryIndex: 0,
        log: appendLog(rt, `Round ${nextRound} 新搜索词：${merged.added.map((q) => q.keyword).join('、')}`),
      },
      nextStep: AUTOPILOT_STEPS.SEARCH_QUERY,
    };
  }

  const STEPS = {
    [AUTOPILOT_STEPS.PLAN]: stepPlan,
    [AUTOPILOT_STEPS.SEARCH_QUERY]: stepSearchQuery,
    [AUTOPILOT_STEPS.FILTER]: stepFilter,
    [AUTOPILOT_STEPS.FETCH_DETAIL]: stepFetchDetail,
    [AUTOPILOT_STEPS.SCORE]: stepScore,
    [AUTOPILOT_STEPS.EVALUATE]: stepEvaluate,
    [AUTOPILOT_STEPS.REPLAN]: stepReplan,
    [AUTOPILOT_STEPS.OUTREACH_CREATE]: stepOutreachCreate,
    [AUTOPILOT_STEPS.OUTREACH_EXECUTE]: stepOutreachExecute,
    [AUTOPILOT_STEPS.ROUND_END]: stepRoundEnd,
    [AUTOPILOT_STEPS.NEXT_ROUND_PLAN]: stepNextRoundPlan,
  };

  /**
   * 推进一个 bounded step。
   * @returns {Promise<{ok: boolean, status: string, step: string, advanced: boolean, done: boolean, reason?: string, code?: string}>}
   */
  /** @returns {Promise<{ok: boolean, status: string, step: string, advanced: boolean, done: boolean, reason?: string, code?: string}>} */
  async function advanceAutopilot() {
    const rt = await loadRuntime();

    if (rt.status === AUTOPILOT_STATUS.PAUSED || rt.status === AUTOPILOT_STATUS.ERROR) {
      return { ok: true, status: rt.status, step: rt.step, advanced: false, done: false, reason: rt.pauseReason };
    }
    if (!isActiveStatus(rt.status)) {
      return { ok: true, status: rt.status, step: rt.step, advanced: false, done: true };
    }
    if (rt.step === AUTOPILOT_STEPS.NONE || rt.step === AUTOPILOT_STEPS.FINISH) {
      const fin = await finishOutreach('没有更多步骤', null);
      return { ok: true, status: fin.status, step: AUTOPILOT_STEPS.FINISH, advanced: false, done: true };
    }

    // 跨天保护：昨天启动、今天才被唤醒 → 重新开始今天的 session
    const settings = await deps.settings.loadSettings();
    if (rt.date !== localDate(now())) {
      const reset = await saveRuntime(resetForNewDay(rt, settings, now()), { now: now() });
      await patchRuntime((r) => ({
        ...r,
        sessionId: reset.sessionId,
        status: AUTOPILOT_STATUS.PLANNING,
        step: AUTOPILOT_STEPS.PLAN,
        roundIndex: 1,
        currentRoundStats: emptyRoundStats(1),
        startedAt: now().toISOString(),
        log: appendLog(r, '跨天：已重置为今天的新 Session'),
      }));
      activity('检测到跨天，Autopilot 已重置为今天的新 Session');
      return { ok: true, status: AUTOPILOT_STATUS.PLANNING, step: AUTOPILOT_STEPS.PLAN, advanced: true, done: false };
    }

    // 工作时间校验：超过结束时间就收工，不为凑 cap 在夜里继续联系（V0.5 §32）
    const inHours = deps.settings.isWithinWorkingHours(
      deps.core.hhmm(now()),
      rt.workingHours?.start ?? settings.workingHours.start,
      rt.workingHours?.end ?? settings.workingHours.end,
    );
    if (!inHours) {
      const win = `${rt.workingHours?.start ?? settings.workingHours.start}-${rt.workingHours?.end ?? settings.workingHours.end}`;
      const fin = await finishOutreach(
        `已超出工作时间（当前本地时间 ${deps.core.hhmm(now())}，工作时间 ${win}）`,
        RISK_REASONS.OUTSIDE_WORKING_HOURS,
      );
      return { ok: true, status: fin.status, step: AUTOPILOT_STEPS.FINISH, advanced: true, done: true };
    }

    const runner = STEPS[rt.step];
    if (!runner) {
      const fin = await finishOutreach(`未知步骤 ${rt.step}`, null);
      return { ok: true, status: fin.status, step: AUTOPILOT_STEPS.FINISH, advanced: false, done: true };
    }

    let result;
    try {
      result = await runner(rt);
    } catch (e) {
      const message = String(e?.message ?? e);
      await patchRuntime((r) => ({ ...r, lastError: message, log: appendLog(r, `Step ${rt.step} 异常：${message}`) }));
      return { ok: false, status: rt.status, step: rt.step, advanced: false, done: false, reason: message };
    }

    if (result?.patch) {
      await patchRuntime((r) => ({ ...r, ...result.patch }));
    }

    if (result?.pause) {
      await pause(result.pause, result.code ?? null);
      return { ok: true, status: AUTOPILOT_STATUS.PAUSED, step: rt.step, advanced: true, done: false, reason: result.pause, code: result.code };
    }

    if (result?.toolFailure) {
      const failures = (rt.consecutiveToolFailures ?? 0) + 1;
      await patchRuntime((r) => ({
        ...r,
        consecutiveToolFailures: failures,
        lastError: result.toolFailure.message,
        log: appendLog(r, `工具失败 ${failures}/${FAILURE_THRESHOLD}：${result.toolFailure.message}`),
      }));
      if (failures >= FAILURE_THRESHOLD) {
        await pause(
          `连续 ${failures} 次浏览器操作失败：${result.toolFailure.message}`,
          RISK_REASONS.BROWSER_TOOL_FAILURE_THRESHOLD,
        );
        return {
          ok: true,
          status: AUTOPILOT_STATUS.PAUSED,
          step: rt.step,
          advanced: true,
          done: false,
          reason: result.toolFailure.message,
          code: RISK_REASONS.BROWSER_TOOL_FAILURE_THRESHOLD,
        };
      }
      return { ok: true, status: rt.status, step: rt.step, advanced: true, done: false, reason: result.toolFailure.message };
    }

    if (result?.finish) {
      const fin = await finishOutreach(result.finish.reason, result.finish.code);
      return { ok: true, status: fin.status, step: AUTOPILOT_STEPS.FINISH, advanced: true, done: true, reason: result.finish.reason };
    }

    const nextStep = result?.nextStep ?? AUTOPILOT_STEPS.FINISH;
    const saved = await patchRuntime((r) => ({
      ...r,
      step: nextStep,
      lastStepAt: now().toISOString(),
      consecutiveToolFailures: 0,
      lastError: null,
    }));

    if (nextStep === AUTOPILOT_STEPS.FINISH) {
      const fin = await finishOutreach('全部步骤完成', null);
      return { ok: true, status: fin.status, step: AUTOPILOT_STEPS.FINISH, advanced: true, done: true };
    }
    return { ok: true, status: saved.status, step: nextStep, advanced: true, done: false };
  }

  async function getStatus() {
    const rt = await loadRuntime();
    const queue = await deps.queue.summarizeActions();
    const states = await deps.states.countByState();
    const daily = await deps.records.getDailyGreetingCount(now());
    const currentQuery = rt.currentPlan?.queries?.[rt.currentQueryIndex]?.keyword ?? null;
    return {
      ok: true,
      status: rt.status,
      step: rt.step,
      paused: rt.paused,
      pauseReason: rt.pauseReason,
      lastRisk: rt.lastRisk,
      lastError: rt.lastError,
      date: rt.date,
      sessionId: rt.sessionId,
      roundIndex: rt.roundIndex,
      maxDiscoveryRounds: rt.maxDiscoveryRounds,
      currentQuery,
      searchedQueries: (rt.searchedQueries ?? []).map((q) => q.keyword),
      recommended: (rt.recommendedJobIds ?? []).length,
      eligible: (rt.eligibleJobIds ?? []).length,
      roundTarget: rt.currentRoundStats?.roundTarget ?? rt.batchQualifiedTarget ?? null,
      todayGreetingCount: daily.effective,
      dailyGreetingCap: rt.dailyGreetingCap,
      queue,
      jobStates: states,
      log: (rt.log ?? []).slice(-30),
      activeActionId: rt.activeActionId,
      startedAt: rt.startedAt,
      completedAt: rt.completedAt,
      updatedAt: rt.updatedAt,
      lastStepAt: rt.lastStepAt,
      cityConflictWarning: rt.cityConflictWarning ?? null,
    };
  }

  /**
   * Service Worker 重启后的恢复（V0.5 §38，Release Blocking Requirement）：
   * 处于 executing 的 Action 一律标记 requires_manual —— 绝不自动重发 Greeting。
   */
  /** @returns {Promise<{ok: boolean, recovered: number, actions: object[]}>} */
  async function recoverInterrupted() {
    const rt = await loadRuntime();
    const recovered = await deps.queue.recoverInterruptedActions({ now: now() });
    if (recovered.count > 0) {
      await patchRuntime((r) => ({
        ...r,
        activeActionId: null,
        log: appendLog(r, `${recovered.count} 个 Action 执行中断 → requires_manual（不自动重发）`),
      }));
      activity(`${recovered.count} 个 Action 上次执行中断，已标记为需人工确认（不会自动重发）`);
    } else if (rt.activeActionId) {
      await patchRuntime((r) => ({ ...r, activeActionId: null }));
    }
    return { ok: true, recovered: recovered.count, actions: recovered.recovered };
  }

  return {
    startAutopilot,
    advanceAutopilot,
    recoverInterrupted,
    pause,
    pauseByUser,
    resumeAutopilot,
    stopAutopilot,
    getStatus,
    validateStart,
    finishOutreach,
  };
}

async function promiseOr(fn, fallback) {
  try {
    const v = await fn();
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
