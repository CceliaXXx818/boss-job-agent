// report-builder.js —— V0.5 Phase 4：求职执行日报（纯函数，deterministic）
//
// 原则（V0.5 §5 / §15 / §27 / §38）：
//   · 所有数字只来自 Event Store / Job State / Runtime 的结构化字段，
//     **绝不解析 Activity Log 字符串，也不调用 LLM**。
//   · 没有监测能力的指标（HR 回复 / 简历 / 面试）在本阶段**字段不存在**，
//     而不是显示 0（0 不是事实）。
//   · 本模块只读输入，返回结构化对象；不写 storage、不改 Job State / Action Queue。
//
// 输入由调用方提供（daily-report-service.js 读取当天分区后传入），
// 因此本模块可以在 Node 里用纯数据完整测试。

export const REPORT_VERSION = 1;

/** 推荐线（与 core-logic 的 DEFAULT_QUALIFIED_SCORE_THRESHOLD 一致）：仅用于"高质量候选"筛选与文案 */
export const RECOMMEND_SCORE_THRESHOLD = 75;

export const STOP_REASON_LABELS = Object.freeze({
  DAILY_CAP_REACHED: '已达到今日联系上限',
  MAX_ROUNDS_REACHED: '已达到最大探索轮次',
  NO_NEW_RESULTS: '没有新的有效搜索方向',
  OUTSIDE_WORKING_HOURS: '已超出工作时间',
  USER_STOPPED: '用户主动停止',
  AUTOPILOT_PAUSED: '因异常暂停',
  IN_PROGRESS: '仍在进行中（今天尚未结束）',
  NO_SESSION: '今天没有启动 Autopilot',
});

export function stopReasonLabel(code) {
  if (!code) return STOP_REASON_LABELS.NO_SESSION;
  return STOP_REASON_LABELS[code] ?? String(code);
}

/** 事件类型常量（避免拼错字符串；与 event-store.EVENT_TYPES 的键一致） */
export const REPORT_EVENT_TYPES = Object.freeze({
  JOB_DISCOVERED: 'JOB_DISCOVERED',
  JOB_SCORED: 'JOB_SCORED',
  JOB_SHORTLISTED: 'JOB_SHORTLISTED',
  GREETING_SENT: 'GREETING_SENT',
  GREETING_FAILED: 'GREETING_FAILED',
  DISCOVERY_ROUND_STARTED: 'DISCOVERY_ROUND_STARTED',
  DISCOVERY_ROUND_COMPLETED: 'DISCOVERY_ROUND_COMPLETED',
  REPLAN_DECIDED: 'REPLAN_DECIDED',
  ACTION_CREATED: 'ACTION_CREATED',
  ACTION_SKIPPED: 'ACTION_SKIPPED',
  ACTION_REQUIRES_MANUAL: 'ACTION_REQUIRES_MANUAL',
  AUTOPILOT_STARTED: 'AUTOPILOT_STARTED',
  AUTOPILOT_PAUSED: 'AUTOPILOT_PAUSED',
  AUTOPILOT_RESUMED: 'AUTOPILOT_RESUMED',
  AUTOPILOT_STOPPED: 'AUTOPILOT_STOPPED',
  AUTOPILOT_OUTREACH_COMPLETE: 'AUTOPILOT_OUTREACH_COMPLETE',
  DAILY_REPORT_GENERATED: 'DAILY_REPORT_GENERATED',
});

const byTime = (a, b) => String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? ''));
const uniqBy = (list, keyOf) => {
  const map = new Map();
  for (const item of list ?? []) {
    const k = keyOf(item);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, item);
  }
  return [...map.values()];
};
const hhmmOf = (iso) => {
  const t = String(iso ?? '');
  return t.length >= 16 ? t.slice(11, 16) : '';
};

/**
 * @typedef {{
 *   jobId: string|null, jobTitle: string|null, company: string|null, score: number|null,
 *   salary: string|null, href: string|null, state: string|null, contacted: boolean, contactedAt: string|null
 * }} ReportCandidate
 */

/**
 * @param {{
 *   date: string,
 *   events: Array<any>,
 *   jobStates?: Record<string, any>,
 *   settings?: any,
 *   runtime?: any,
 *   generatedAt?: string|null
 * }} input
 * @returns {{
 *   date: string, generatedAt: string|null, version: number, hasActivity: boolean,
 *   summary: any, outreach: any, rounds: any[], searchStrategy: any[],
 *   topCandidates: ReportCandidate[], remainingCandidates: ReportCandidate[],
 *   remainingCandidatesTotal: number, contactedToday: any[], issues: any[], system: any
 * }}
 */
export function buildDailyReport({ date, events = [], jobStates = {}, settings = {}, runtime = null, generatedAt = null }) {
  // 先按事件自身的唯一性去重（幂等键优先，其次是 eventId），再按 jobId 做业务去重。
  // 这样"同一天写入两份相同事件"（重放 / 导入 / 测试）不会让任何指标翻倍。
  const seenEventKeys = new Set();
  const list = [...events]
    .filter((e) => {
      const k = e?.idempotencyKey ? `${e.type}|${e.idempotencyKey}` : `id|${e?.eventId}`;
      if (seenEventKeys.has(k)) return false;
      seenEventKeys.add(k);
      return true;
    })
    .sort(byTime);
  const of = (type) => list.filter((e) => e.type === type);

  // ---------------- 基础去重集合（幂等键已保证唯一，这里再按 jobId 去重） ----------------
  const discovered = uniqBy(of(REPORT_EVENT_TYPES.JOB_DISCOVERED), (e) => e.jobId);
  const scored = uniqBy(of(REPORT_EVENT_TYPES.JOB_SCORED), (e) => e.jobId);
  const shortlisted = uniqBy(of(REPORT_EVENT_TYPES.JOB_SHORTLISTED), (e) => e.jobId);
  const contactedEvents = uniqBy(of(REPORT_EVENT_TYPES.GREETING_SENT), (e) => e.jobId);
  const failedEvents = of(REPORT_EVENT_TYPES.GREETING_FAILED);
  const roundCompleted = of(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED).sort(
    (a, b) => Number(a.metadata?.roundIndex ?? 0) - Number(b.metadata?.roundIndex ?? 0),
  );
  const roundStarted = of(REPORT_EVENT_TYPES.DISCOVERY_ROUND_STARTED);
  const replanEvents = of(REPORT_EVENT_TYPES.REPLAN_DECIDED);
  const startedEvents = of(REPORT_EVENT_TYPES.AUTOPILOT_STARTED);
  const pausedEvents = of(REPORT_EVENT_TYPES.AUTOPILOT_PAUSED);
  const stoppedEvents = of(REPORT_EVENT_TYPES.AUTOPILOT_STOPPED);
  const completedEvents = of(REPORT_EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE);
  const requiresManual = of(REPORT_EVENT_TYPES.ACTION_REQUIRES_MANUAL);
  const skippedEvents = of(REPORT_EVENT_TYPES.ACTION_SKIPPED);

  const contactedIds = new Set(contactedEvents.map((e) => e.jobId).filter(Boolean));
  const scoreOf = new Map();
  for (const e of scored) scoreOf.set(e.jobId, Number(e.metadata?.score));
  for (const e of shortlisted) {
    if (!scoreOf.has(e.jobId)) scoreOf.set(e.jobId, Number(e.metadata?.score));
  }

  // ---------------- Summary ----------------
  const searchQueries = uniqBy(
    roundCompleted.flatMap((e) =>
      (e.metadata?.searchedQueries ?? []).map((kw) => ({ city: e.metadata?.city ?? null, keyword: kw })),
    ),
    (q) => `${q.city ?? ''}|${String(q.keyword ?? '').toLowerCase()}`,
  );
  const replans = replanEvents.length;
  const replansWithNewQueries = replanEvents.filter((e) => (e.metadata?.addedQueries ?? []).length > 0).length;
  // 老数据（Phase 3 修复前）没有 REPLAN_DECIDED 事件 → 退回 round metadata 里的 replanCount
  const replanFallback = roundCompleted.reduce((n, e) => n + (Number(e.metadata?.replanCount) || 0), 0);

  const summary = {
    discovered: discovered.length,
    analyzed: scored.length,
    recommended: shortlisted.length,
    contacted: contactedEvents.length,
    greetingFailed: failedEvents.length,
    discoveryRounds: roundCompleted.length,
    searchQueries: searchQueries.length,
    replans: replans || replanFallback,
    replansWithNewQueries,
    replansSource: replans ? 'events' : replanFallback ? 'round-metadata' : 'none',
  };

  // ---------------- Outreach ----------------
  const startMeta = startedEvents[0]?.metadata ?? {};
  const dailyCap = Number(startMeta.dailyGreetingCap ?? settings.dailyGreetingCap ?? 0) || 0;
  const contacted = summary.contacted;
  const remainingQuota = Math.max(0, dailyCap - contacted);

  const lastStop = [...completedEvents].pop() ?? null;
  let stopReason = 'NO_SESSION';
  if (lastStop) stopReason = lastStop.metadata?.code ?? 'AUTOPILOT_PAUSED';
  else if (stoppedEvents.length) stopReason = 'USER_STOPPED';
  else if (pausedEvents.length) stopReason = 'AUTOPILOT_PAUSED';
  else if (startedEvents.length) stopReason = 'IN_PROGRESS';

  const modes = contactedEvents.map((e) => e.metadata?.mode ?? null);
  const modeSplit = modes.every((m) => m === 'review' || m === 'autopilot')
    ? {
        autopilot: modes.filter((m) => m === 'autopilot').length,
        review: modes.filter((m) => m === 'review').length,
      }
    : null;

  const outreach = {
    dailyCap,
    contacted,
    goalReached: dailyCap > 0 && contacted >= dailyCap,
    remainingQuota,
    stopReason,
    stopReasonLabel: stopReasonLabel(stopReason),
    stopReasonDetail: lastStop?.metadata?.reason ?? null,
    modeSplit,
    sessions: startedEvents.length,
    policySkips: skippedEvents.filter((e) => e.metadata?.source === 'policy').length,
  };

  // ---------------- Rounds ----------------
  const rounds = roundCompleted.map((e) => {
    const m = e.metadata ?? {};
    const roundIndex = Number(m.roundIndex ?? 0);
    const started = roundStarted.find((x) => Number(x.metadata?.roundIndex) === roundIndex);
    // 每轮联系数：优先用 GREETING_SENT.metadata.roundIndex（Phase 4 起写入，精确）；
    // 老事件没有该字段时退化为"上一次轮次完成 ~ 本次轮次完成"的时间窗（最后一轮无上界）。
    // 依据：第 N 轮的打招呼发生在该轮 ROUND_END 之前，因此落在 (rc_{N-1}, rc_N] 区间内。
    const completedTimes = roundCompleted.map((x) => String(x.timestamp ?? ''));
    const myIdx = completedTimes.indexOf(String(e.timestamp ?? ''));
    const lowerBound = myIdx > 0 ? completedTimes[myIdx - 1] : null;
    const upperBound = myIdx >= 0 && myIdx < completedTimes.length - 1 ? completedTimes[myIdx] : null;
    const roundContacted = contactedEvents.filter((c) => {
      const explicit = Number(c.metadata?.roundIndex ?? NaN);
      if (Number.isFinite(explicit)) return explicit === roundIndex;
      const t = String(c.timestamp ?? '');
      if (lowerBound && t <= lowerBound) return false;
      if (upperBound && t > upperBound) return false;
      return true;
    }).length;
    const decisions = replanEvents.filter((x) => Number(x.metadata?.roundIndex ?? NaN) === roundIndex);
    const replan = decisions.length
      ? {
          attempted: true,
          addedQueries: decisions.flatMap((d) => d.metadata?.addedQueries ?? []),
          reasons: decisions.map((d) => d.metadata?.reason).filter(Boolean),
          sources: decisions.map((d) => d.metadata?.source),
        }
      : { attempted: Number(m.replanCount) > 0, addedQueries: [], reasons: [], sources: [] };
    return {
      roundIndex,
      searchQueries: m.searchedQueries ?? [],
      discovered: Number(m.discoveredCount) || 0,
      newDiscovered: Number(m.newDiscoveredCount) || 0,
      filtered: Number(m.filteredCount) || 0,
      analyzed: Number(m.analyzedCount) || 0,
      recommended: Number(m.recommendedCount) || 0,
      // Auto Eligible 只在事件里确实有该字段时才给出（V0.5 §7：不可靠就不显示）
      eligible: Number.isFinite(Number(m.eligibleCount)) && m.eligibleCount !== undefined ? Number(m.eligibleCount) : null,
      roundTarget: Number.isFinite(Number(m.roundTarget)) && m.roundTarget ? Number(m.roundTarget) : null,
      contacted: roundContacted,
      replan,
      startedAt: started?.timestamp ?? null,
      completedAt: e.timestamp ?? null,
      city: m.city ?? null,
    };
  });

  // ---------------- Top candidates（当天分数最高的 5 个，含已联系与未联系） ----------------
  const jobMeta = new Map();
  for (const e of discovered) {
    jobMeta.set(e.jobId, {
      jobTitle: e.jobTitle,
      company: e.company,
      href: e.metadata?.href ?? null,
      salary: e.metadata?.salary ?? null,
      city: e.metadata?.city ?? null,
    });
  }
  const contactedAt = new Map(contactedEvents.map((e) => [e.jobId, e.timestamp]));

  const candidateRows = uniqBy([...shortlisted, ...scored], (e) => e.jobId)
    .map((e) => {
      const meta = jobMeta.get(e.jobId) ?? {};
      const state = jobStates?.[e.jobId]?.state ?? null;
      return {
        jobId: e.jobId,
        jobTitle: e.jobTitle ?? meta.jobTitle ?? null,
        company: e.company ?? meta.company ?? null,
        score: Number.isFinite(Number(e.metadata?.score ?? scoreOf.get(e.jobId)))
          ? Number(e.metadata?.score ?? scoreOf.get(e.jobId))
          : null,
        salary: meta.salary ?? null,
        href: e.metadata?.href ?? meta.href ?? null,
        state,
        contacted: contactedIds.has(e.jobId),
        contactedAt: contactedAt.get(e.jobId) ?? null,
      };
    })
    .filter((r) => r.score != null);

  const topCandidates = [...candidateRows].sort((a, b) => b.score - a.score).slice(0, 5);

  // ---------------- Remaining candidates（今天评过/入过推荐、但没有联系的高质量岗位） ----------------
  const remainingAll = candidateRows
    .filter((r) => !r.contacted && r.score >= RECOMMEND_SCORE_THRESHOLD && r.state !== 'REJECTED')
    .sort((a, b) => b.score - a.score);
  const remainingCandidates = remainingAll.slice(0, 10);

  // ---------------- Contacted today（含话术策略，但不默认展示全文） ----------------
  const contactedToday = contactedEvents.map((e) => {
    const meta = jobMeta.get(e.jobId) ?? {};
    return {
      at: e.timestamp,
      time: hhmmOf(e.timestamp),
      jobId: e.jobId,
      jobTitle: e.jobTitle ?? meta.jobTitle ?? null,
      company: e.company ?? meta.company ?? null,
      score: Number.isFinite(Number(e.metadata?.score)) ? Number(e.metadata?.score) : null,
      href: e.metadata?.href ?? meta.href ?? null,
      mode: e.metadata?.mode ?? null,
      greetingStrategy: e.metadata?.messageStrategy?.mode ?? null,
      templateId: e.metadata?.templateId ?? e.metadata?.messageStrategy?.templateId ?? null,
      actionId: e.metadata?.actionId ?? null,
    };
  });

  // ---------------- Issues ----------------
  const issues = [];
  for (const e of failedEvents) {
    issues.push({
      at: e.timestamp,
      time: hhmmOf(e.timestamp),
      type: 'GREETING_FAILED',
      title: e.jobTitle ?? e.jobId ?? '打招呼失败',
      detail: e.metadata?.error ?? '未说明原因',
      code: null,
    });
  }
  for (const e of pausedEvents) {
    issues.push({
      at: e.timestamp,
      time: hhmmOf(e.timestamp),
      type: 'AUTOPILOT_PAUSED',
      title: 'Autopilot 暂停',
      detail: e.metadata?.reason ?? '',
      code: e.metadata?.code ?? null,
    });
  }
  for (const e of requiresManual) {
    issues.push({
      at: e.timestamp,
      time: hhmmOf(e.timestamp),
      type: 'ACTION_REQUIRES_MANUAL',
      title: e.jobTitle ?? e.jobId ?? 'Action 需人工确认',
      detail: e.metadata?.reason ?? '',
      code: null,
    });
  }
  issues.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const riskCodes = uniqBy(
    pausedEvents.filter((e) => e.metadata?.code && e.metadata.code !== 'USER_PAUSED'),
    (e) => e.metadata?.code,
  ).map((e) => e.metadata.code);

  const system = {
    finalStatus: runtime?.status ?? (contacted || discovered.length ? 'UNKNOWN' : 'IDLE'),
    pausedCount: pausedEvents.length,
    resumedCount: of(REPORT_EVENT_TYPES.AUTOPILOT_RESUMED).length,
    riskEvents: riskCodes,
    sessions: startedEvents.length,
    lastSessionId: runtime?.sessionId ?? null,
    lastStepAt: runtime?.lastStepAt ?? null,
    // 明确标注本阶段没有的能力（这是"能力开关"，不是数据字段；绝不输出假的 0）
    capabilities: { hrReplyMonitoring: false, resumeMonitoring: false, interviewTracking: false },
  };

  return {
    date,
    generatedAt,
    version: REPORT_VERSION,
    hasActivity: Boolean(discovered.length || scored.length || contacted.length || startedEvents.length),
    summary,
    outreach,
    rounds,
    searchStrategy: rounds.map((r) => ({ roundIndex: r.roundIndex, queries: r.searchQueries })),
    topCandidates,
    remainingCandidates,
    remainingCandidatesTotal: remainingAll.length,
    contactedToday,
    issues,
    system,
  };
}
