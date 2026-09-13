// V0.5 Phase 4：日报聚合测试（deterministic，全部离线）
// 对应规格 §29 聚合、§30 轮次归类、§31 目标达成、§32 停止原因、§35 无数据、§36 不虚构 HR 字段
import { describe, it, expect } from 'vitest';
import {
  buildDailyReport,
  REPORT_EVENT_TYPES,
  RECOMMEND_SCORE_THRESHOLD,
  STOP_REASON_LABELS,
  stopReasonLabel,
} from '../../../extension/report-builder.js';
import { renderDailyReportMarkdown } from '../../../extension/report-markdown.js';

const T = (hhmm: string, ss = '00') => `2026-09-13T${hhmm}:${ss}.000Z`;

const evt = (type: string, jobId: string | null, metadata: Record<string, unknown> = {}, timestamp = T('10:00'), extra: Record<string, unknown> = {}) => ({
  eventId: `evt_${type}_${jobId ?? 'none'}_${timestamp}_${JSON.stringify(metadata).length}`,
  timestamp,
  type,
  jobId,
  company: (metadata.company as string) ?? '某公司',
  jobTitle: (metadata.title as string) ?? `岗位${jobId ?? ''}`,
  metadata,
  idempotencyKey: null,
  ...extra,
});

const discovered = (n: number, meta: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_v, i) => evt(REPORT_EVENT_TYPES.JOB_DISCOVERED, `d-${i + 1}`, { round: 1, mode: 'autopilot', href: `/job_detail/d-${i + 1}.html`, salary: '30-50K', ...meta }));
const scoredEv = (ids: string[], score = (i: number) => 80 + i) =>
  ids.map((id, i) => evt(REPORT_EVENT_TYPES.JOB_SCORED, id, { mode: 'autopilot', score: score(i), tier: 'hot', href: `/job_detail/${id}.html` }));
const shortlistedEv = (ids: string[], score = (i: number) => 80 + i) =>
  ids.map((id, i) => evt(REPORT_EVENT_TYPES.JOB_SHORTLISTED, id, { mode: 'autopilot', score: score(i), href: `/job_detail/${id}.html` }));
const greetingsEv = (ids: string[], meta: Record<string, unknown> = {}) =>
  ids.map((id, i) => evt(REPORT_EVENT_TYPES.GREETING_SENT, id, { mode: 'autopilot', score: 80 + i, href: `/job_detail/${id}.html`, messageStrategy: { mode: 'template', templateId: 'default' }, ...meta }, T('20:38', String(10 + i))));

describe('§29 聚合：20 discovered / 10 scored / 6 shortlisted / 2 sent / 1 failed / 2 rounds', () => {
  const events = [
    ...discovered(20),
    ...scoredEv(Array.from({ length: 10 }, (_v, i) => `d-${i + 1}`)),
    ...shortlistedEv(Array.from({ length: 6 }, (_v, i) => `d-${i + 1}`)),
    ...greetingsEv(['d-1', 'd-2']),
    evt(REPORT_EVENT_TYPES.GREETING_FAILED, 'd-3', { mode: 'autopilot', error: '发送按钮未启用' }, T('20:13')),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, {
      roundIndex: 1, searchedQueries: ['AI产品经理', '大模型产品经理'], discoveredCount: 63, filteredCount: 30, analyzedCount: 15, recommendedCount: 12, eligibleCount: 0, roundTarget: 2, replanCount: 1, city: '上海',
    }),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, {
      roundIndex: 2, searchedQueries: ['智能体产品经理'], discoveredCount: 42, filteredCount: 30, analyzedCount: 15, recommendedCount: 11, eligibleCount: 5, roundTarget: 2, replanCount: 0, city: '上海',
    }),
    evt(REPORT_EVENT_TYPES.AUTOPILOT_STARTED, null, { sessionId: 'ap_1', dailyGreetingCap: 5, todayGreetingCount: 0, city: '上海' }, T('09:57')),
    evt(REPORT_EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE, null, { sessionId: 'ap_1', code: 'MAX_ROUNDS_REACHED', reason: '已达最大搜索轮次 2', roundIndex: 2, todayGreetingCount: 2 }, T('20:39')),
  ];
  const report = buildDailyReport({ date: '2026-09-13', events, jobStates: {}, settings: { dailyGreetingCap: 5 }, runtime: { status: 'MONITORING' } });

  it('去重后的六个核心数字必须精确', () => {
    expect(report.summary).toMatchObject({
      discovered: 20,
      analyzed: 10,
      recommended: 6,
      contacted: 2,
      greetingFailed: 1,
      discoveryRounds: 2,
    });
  });

  it('重复事件不会重复计数（幂等）', () => {
    const dup = buildDailyReport({
      date: '2026-09-13',
      events: [...events, ...events], // 同一天的同一批事件再来一遍
      settings: { dailyGreetingCap: 5 },
    });
    expect(dup.summary).toMatchObject({ discovered: 20, analyzed: 10, recommended: 6, contacted: 2, discoveryRounds: 2 });
  });

  it('搜索词按 city+keyword 去重且只算真实执行过的', () => {
    expect(report.summary.searchQueries).toBe(3);
    expect(report.searchStrategy).toEqual([
      { roundIndex: 1, queries: ['AI产品经理', '大模型产品经理'] },
      { roundIndex: 2, queries: ['智能体产品经理'] },
    ]);
  });

  it('§31 目标达成与剩余额度', () => {
    expect(report.outreach.dailyCap).toBe(5);
    expect(report.outreach.contacted).toBe(2);
    expect(report.outreach.goalReached).toBe(false);
    expect(report.outreach.remainingQuota).toBe(3);
  });

  it('§32 停止原因取机器 code 并翻译成人类可读', () => {
    expect(report.outreach.stopReason).toBe('MAX_ROUNDS_REACHED');
    expect(report.outreach.stopReasonLabel).toBe(STOP_REASON_LABELS.MAX_ROUNDS_REACHED);
  });

  it('Top Candidates 按分数降序且带 href', () => {
    expect(report.topCandidates).toHaveLength(5);
    expect(report.topCandidates[0].score ?? 0).toBeGreaterThanOrEqual(report.topCandidates[4].score ?? 0);
    expect(report.topCandidates[0].href).toContain('/job_detail/');
  });

  it('Remaining Candidates = 今日评分/推荐里未联系的 ≥75 分岗位', () => {
    // 20 个发现里评了 10 个（d-1..d-10，全部 ≥80），其中 2 个已联系 → 剩 8 个
    expect(report.remainingCandidatesTotal).toBe(8);
    expect(report.remainingCandidates.every((c) => !c.contacted && (c.score ?? 0) >= RECOMMEND_SCORE_THRESHOLD)).toBe(true);
  });

  it('Issues 汇总失败事件', () => {
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ type: 'GREETING_FAILED' });
    expect(report.issues[0].detail).toContain('发送按钮');
  });

  it('§36 不虚构 HR / 简历 / 面试数据（字段不存在，而不是 0）', () => {
    // 任何位置都不允许出现"HR 回复 / 简历 / 面试"的**数值字段**
    const BANNED = ['hrReplied', 'hrReplies', 'hrReplyRate', 'resumeSent', 'resumeRequested', 'resumesSent', 'interview', 'interviews'];
    const offenders = (obj: unknown, path = ''): string[] => {
      if (obj === null || typeof obj !== 'object') return [];
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        BANNED.includes(k) ? [`${path}${k}`] : offenders(v, `${path}${k}.`),
      );
    };
    expect(offenders(report)).toEqual([]);
    expect(report.system.capabilities).toEqual({
      hrReplyMonitoring: false,
      resumeMonitoring: false,
      interviewTracking: false,
    });
    // 明确标注"尚未监测"，而不是给个 0 让人误会
    expect(renderDailyReportMarkdown(report)).toContain('尚未监测');
    expect(renderDailyReportMarkdown(report)).not.toContain('HR回复：0');
  });
});

describe('§30 Round metrics 按 roundIndex 归类', () => {
  const events = [
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, {
      roundIndex: 1, searchedQueries: ['a', 'b', 'c', 'd', 'e'], discoveredCount: 63, filteredCount: 30, analyzedCount: 15, recommendedCount: 12, eligibleCount: 0, roundTarget: 2, replanCount: 1, city: '上海',
    }, T('10:10')),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, {
      roundIndex: 2, searchedQueries: ['f', 'g', 'h', 'i'], discoveredCount: 42, filteredCount: 20, analyzedCount: 10, recommendedCount: 5, eligibleCount: 2, roundTarget: 2, replanCount: 0, city: '上海',
    }, T('10:20')),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_STARTED, null, { roundIndex: 1, queries: ['a'] }, T('10:00')),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_STARTED, null, { roundIndex: 2, queries: ['f'] }, T('10:15')),
    ...greetingsEv(['x'], { roundIndex: 2 } as never),
  ];
  const report = buildDailyReport({ date: '2026-09-13', events, settings: { dailyGreetingCap: 5 } });

  it('第 1 轮 5 个搜索词 / 15 分析 / 12 推荐 / 0 联系', () => {
    expect(report.rounds[0]).toMatchObject({ roundIndex: 1, analyzed: 15, recommended: 12, contacted: 0 });
    expect(report.rounds[0].searchQueries).toHaveLength(5);
    expect(report.rounds[0].startedAt).toBe(T('10:00'));
  });

  it('第 2 轮 4 个搜索词 / 10 分析 / 5 推荐 / 1 联系', () => {
    expect(report.rounds[1]).toMatchObject({ roundIndex: 2, analyzed: 10, recommended: 5, contacted: 1 });
    expect(report.rounds[1].searchQueries).toHaveLength(4);
  });

  it('Eligible 只在事件确实带该字段时给出（V0.5 §7）', () => {
    expect(report.rounds[0].eligible).toBe(0);
    expect(report.rounds[1].eligible).toBe(2);
    const noEligible = buildDailyReport({
      date: '2026-09-13',
      events: [evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, { roundIndex: 1, searchedQueries: ['a'], discoveredCount: 1 })],
    });
    expect(noEligible.rounds[0].eligible).toBeNull(); // 不猜
  });
});

describe('§32 六种停止原因与兜底', () => {
  const started = evt(REPORT_EVENT_TYPES.AUTOPILOT_STARTED, null, { dailyGreetingCap: 5 }, T('09:00'));
  const cases: Array<[string, string, string]> = [
    ['DAILY_CAP_REACHED', '已达到今日联系上限', 'complete'],
    ['MAX_ROUNDS_REACHED', '已达到最大探索轮次', 'complete'],
    ['NO_NEW_RESULTS', '没有新的有效搜索方向', 'complete'],
    ['OUTSIDE_WORKING_HOURS', '已超出工作时间', 'complete'],
  ];

  it.each(cases)('%s → %s', (code, label) => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [started, evt(REPORT_EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE, null, { code }, T('20:00'))],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.outreach.stopReason).toBe(code);
    expect(report.outreach.stopReasonLabel).toBe(label);
    expect(stopReasonLabel(code)).toBe(label);
  });

  it('用户 Stop → USER_STOPPED', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [started, evt(REPORT_EVENT_TYPES.AUTOPILOT_STOPPED, null, {}, T('20:00'))],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.outreach.stopReason).toBe('USER_STOPPED');
    expect(report.outreach.stopReasonLabel).toBe('用户主动停止');
  });

  it('暂停（未收工）→ AUTOPILOT_PAUSED，并进入 issues', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [started, evt(REPORT_EVENT_TYPES.AUTOPILOT_PAUSED, null, { reason: 'AI 服务未连接', code: 'AI_SERVICE_UNAVAILABLE' }, T('20:13'))],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.outreach.stopReason).toBe('AUTOPILOT_PAUSED');
    expect(report.outreach.stopReasonLabel).toBe('因异常暂停');
    expect(report.issues[0]).toMatchObject({ type: 'AUTOPILOT_PAUSED' });
    expect(report.system.riskEvents).toEqual(['AI_SERVICE_UNAVAILABLE']);
  });

  it('启动但还没有终态 → IN_PROGRESS；完全没启动 → NO_SESSION', () => {
    expect(buildDailyReport({ date: '2026-09-13', events: [started] }).outreach.stopReason).toBe('IN_PROGRESS');
    expect(buildDailyReport({ date: '2026-09-13', events: [] }).outreach.stopReason).toBe('NO_SESSION');
  });
});

describe('§35 无数据也能正常生成', () => {
  const report = buildDailyReport({ date: '2026-09-13', events: [], settings: { dailyGreetingCap: 5 } });

  it('不报错、数字为 0、hasActivity=false', () => {
    expect(report.hasActivity).toBe(false);
    expect(report.summary).toMatchObject({ discovered: 0, analyzed: 0, recommended: 0, contacted: 0 });
    expect(report.topCandidates).toEqual([]);
    expect(report.remainingCandidates).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  it('Markdown 明确写"今天没有岗位搜索活动"', () => {
    const md = renderDailyReportMarkdown(report);
    expect(md).toContain('今天没有岗位搜索活动');
    expect(md).toContain('No issues today.');
  });
});

describe('§12/§37 候选与来源可读性', () => {
  it('mode metadata 齐全时给出 Autopilot / Review 拆分', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [...greetingsEv(['a'], { mode: 'autopilot' }), ...greetingsEv(['b'], { mode: 'review' })],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.outreach.modeSplit).toEqual({ autopilot: 1, review: 1 });
    expect(report.outreach.contacted).toBe(2);
  });

  it('老事件缺 mode → 不给拆分（而不是瞎猜）', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [...greetingsEv(['a'], { mode: 'autopilot' }), ...greetingsEv(['b'], { mode: undefined } as never)],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.outreach.modeSplit).toBeNull();
    expect(report.outreach.contacted).toBe(2);
  });

  it('已联系的岗位不会出现在 Remaining，且 Top 里标为"已联系"', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [...scoredEv(['a', 'b'], (i) => 95 - i * 5), ...shortlistedEv(['a', 'b'], (i) => 95 - i * 5), ...greetingsEv(['a'])],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.remainingCandidates.map((c) => c.jobId)).toEqual(['b']);
    expect(report.topCandidates.find((c) => c.jobId === 'a')?.contacted).toBe(true);
  });
});

describe('§24 Markdown 渲染器（与统计解耦）', () => {
  const report = buildDailyReport({
    date: '2026-09-13',
    events: [
      evt(REPORT_EVENT_TYPES.AUTOPILOT_STARTED, null, { dailyGreetingCap: 2 }, T('09:00')),
      ...discovered(3),
      ...scoredEv(['d-1', 'd-2', 'd-3'], () => 90),
      ...shortlistedEv(['d-1', 'd-2'], () => 90),
      ...greetingsEv(['d-1']),
      evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, {
        roundIndex: 1, searchedQueries: ['AI产品经理'], discoveredCount: 3, filteredCount: 3, analyzedCount: 3, recommendedCount: 2, eligibleCount: 1, roundTarget: 2, replanCount: 0, city: '上海',
      }, T('10:30')),
      evt(REPORT_EVENT_TYPES.REPLAN_DECIDED, null, { roundIndex: 1, decision: 'continue', reason: '候选不足', addedQueries: ['补充词'], source: 'in-round', eligibleCount: 0, targetCandidates: 2 }, T('10:20')),
      evt(REPORT_EVENT_TYPES.AUTOPILOT_OUTREACH_COMPLETE, null, { code: 'DAILY_CAP_REACHED', reason: '已达今日上限 2' }, T('20:00')),
    ],
    settings: { dailyGreetingCap: 2 },
    runtime: { status: 'MONITORING' },
  });

  it('包含全部关键小节', () => {
    const md = renderDailyReportMarkdown(report);
    for (const section of ['# 求职执行日报 2026-09-13', '## 今日汇总', '## Outreach', '## 每轮表现', '## 搜索策略', '## 高分岗位', '## 今日未联系的高质量候选', '## 今日已联系岗位', '## 异常与暂停', '## 尚未监测']) {
      expect(md, `缺小节 ${section}`).toContain(section);
    }
  });

  it('Replan 决策在 Markdown 中可见（含"判定无需补充"）', () => {
    const md = renderDailyReportMarkdown(report);
    expect(md).toContain('补充搜索：是（新增 补充词）');
    const noReplan = buildDailyReport({
      date: '2026-09-13',
      events: [
        evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, { roundIndex: 1, searchedQueries: ['a'], replanCount: 1 }),
        evt(REPORT_EVENT_TYPES.REPLAN_DECIDED, null, { roundIndex: 1, decision: 'complete', addedQueries: [], source: 'in-round' }),
      ],
    });
    expect(renderDailyReportMarkdown(noReplan)).toContain('判定无需补充');
  });

  it('统计与渲染分离：渲染器只吃 report 对象，不接触 storage', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('extension/report-markdown.js', 'utf8'));
    expect(src).not.toMatch(/chrome\./); // 不认识 chrome API
    expect(src).not.toMatch(/chrome\.storage|local\.get|local\.set/);
    expect(src).toMatch(/export function renderDailyReportMarkdown/);
  });
});

describe('§30 每轮联系数归类（显式 roundIndex 优先，老数据按时间窗兜底）', () => {
  const rounds = [
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, { roundIndex: 1, searchedQueries: ['a'], discoveredCount: 10 }, T('10:10')),
    evt(REPORT_EVENT_TYPES.DISCOVERY_ROUND_COMPLETED, null, { roundIndex: 2, searchedQueries: ['b'], discoveredCount: 20 }, T('10:30')),
  ];

  it('显式 roundIndex：分别归到第 1 / 第 2 轮', () => {
    const report = buildDailyReport({
      date: '2026-09-13',
      events: [
        ...rounds,
        ...greetingsEv(['x'], { roundIndex: 1 } as never),
        ...greetingsEv(['y'], { roundIndex: 2 } as never),
        ...greetingsEv(['z'], { roundIndex: 2 } as never),
      ],
      settings: { dailyGreetingCap: 5 },
    });
    expect(report.rounds.map((r) => r.contacted)).toEqual([1, 2]);
    expect(report.summary.contacted).toBe(3);
  });

  it('老事件没有 roundIndex：按时间窗归类（第 N 轮打招呼发生在其 ROUND_END 之前）', () => {
    const legacy = [
      // 10:05 在第 1 轮完成（10:10）之前 → 属于第 1 轮的 outreach
      { ...evt(REPORT_EVENT_TYPES.GREETING_SENT, 'a', { mode: 'autopilot', score: 90 }), timestamp: T('10:05') },
      // 10:20 在第 1 轮完成之后、第 2 轮完成之前 → 属于第 2 轮
      { ...evt(REPORT_EVENT_TYPES.GREETING_SENT, 'b', { mode: 'autopilot', score: 90 }), timestamp: T('10:20') },
      // 10:40 在最后一轮完成之后（例如中途被工作时间打断）→ 归到最后一轮
      { ...evt(REPORT_EVENT_TYPES.GREETING_SENT, 'c', { mode: 'autopilot', score: 90 }), timestamp: T('10:40') },
    ];
    const report = buildDailyReport({ date: '2026-09-13', events: [...rounds, ...legacy], settings: { dailyGreetingCap: 5 } });
    expect(report.rounds.map((r) => r.contacted)).toEqual([1, 2]);
    expect(report.summary.contacted).toBe(3);
  });

  it('时间窗在下一轮开始前不会把联系数算到未来的轮', () => {
    const legacy = [{ ...evt(REPORT_EVENT_TYPES.GREETING_SENT, 'x', { mode: 'autopilot', score: 90 }), timestamp: T('10:05') }];
    const report = buildDailyReport({ date: '2026-09-13', events: [...rounds, ...legacy], settings: { dailyGreetingCap: 5 } });
    expect(report.rounds.map((r) => r.contacted)).toEqual([1, 0]);
  });
});
