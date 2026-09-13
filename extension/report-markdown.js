// report-markdown.js —— V0.5 Phase 4：日报 Markdown 渲染（与统计解耦）
//
// 用途：导出 Markdown / 未来 Email 的纯文本 fallback。
// 只依赖结构化 report 对象，不认识 storage / DOM / chrome API。

import { RECOMMEND_SCORE_THRESHOLD, STOP_REASON_LABELS } from './report-builder.js';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function renderDailyReportMarkdown(report) {
  const r = report ?? {};
  const L = [];
  L.push(`# 求职执行日报 ${r.date}`, '');
  if (r.generatedAt) L.push(`> 生成时间：${r.generatedAt}（本地时间显示见 Side Panel）`, '');

  if (!r.hasActivity) {
    L.push('今天没有岗位搜索活动。', '');
  }

  // ---------------- TODAY ----------------
  L.push('## 今日汇总', '');
  L.push('| 指标 | 数量 |');
  L.push('|---|---:|');
  L.push(`| 发现岗位 | ${r.summary?.discovered ?? 0} |`);
  L.push(`| AI 分析 | ${r.summary?.analyzed ?? 0} |`);
  L.push(`| AI 推荐（≥${RECOMMEND_SCORE_THRESHOLD}） | ${r.summary?.recommended ?? 0} |`);
  L.push(`| 已联系 | ${r.summary?.contacted ?? 0} |`);
  L.push(`| 联系失败 | ${r.summary?.greetingFailed ?? 0} |`);
  L.push(`| 探索轮次 | ${r.summary?.discoveryRounds ?? 0} |`);
  L.push(`| 搜索词（去重） | ${r.summary?.searchQueries ?? 0} |`);
  L.push(`| 补充搜索（Replan） | ${r.summary?.replans ?? 0} |`);
  L.push('');

  // ---------------- OUTREACH ----------------
  L.push('## Outreach', '');
  L.push(`- 今日联系上限：${r.outreach?.dailyCap ?? 0}`);
  L.push(`- 已联系：${r.outreach?.contacted ?? 0} / ${r.outreach?.dailyCap ?? 0}`);
  L.push(`- 目标：${r.outreach?.goalReached ? '✅ 已达成' : '未达成（剩余额度 ' + (r.outreach?.remainingQuota ?? 0) + '）'}`);
  L.push(`- 停止原因：${r.outreach?.stopReasonLabel ?? STOP_REASON_LABELS.NO_SESSION}${r.outreach?.stopReasonDetail ? `（${r.outreach.stopReasonDetail}）` : ''}`);
  if (r.outreach?.modeSplit) {
    L.push(`- 联系来源：Autopilot ${r.outreach.modeSplit.autopilot} 个 / Review ${r.outreach.modeSplit.review} 个`);
  }
  L.push('');

  // ---------------- ROUNDS ----------------
  if ((r.rounds ?? []).length) {
    L.push('## 每轮表现', '');
    for (const round of r.rounds) {
      L.push(`### Round ${round.roundIndex}${round.city ? `（${round.city}）` : ''}`, '');
      L.push(`- 搜索词：${round.searchQueries?.length ?? 0} 个：${(round.searchQueries ?? []).join('、') || '—'}`);
      L.push(`- 发现 ${round.discovered}｜过滤后 ${round.filtered}｜分析 ${round.analyzed}｜推荐 ${round.recommended}`);
      if (round.eligible !== null) {
        L.push(`- 可自动联系候选：${round.eligible}${round.roundTarget ? ` / 目标 ${round.roundTarget}` : ''}`);
      }
      L.push(`- 本轮联系：${round.contacted}`);
      L.push(
        `- 补充搜索：${round.replan?.attempted ? `是${round.replan.addedQueries?.length ? `（新增 ${round.replan.addedQueries.join('、')}）` : '（判定无需补充）'}` : '否'}`,
      );
      L.push('');
    }
  }

  // ---------------- SEARCH STRATEGY ----------------
  if ((r.searchStrategy ?? []).length) {
    L.push('## 搜索策略', '');
    for (const s of r.searchStrategy) {
      L.push(`- **Round ${s.roundIndex}**：${(s.queries ?? []).join('、') || '—'}`);
    }
    L.push('');
  }

  // ---------------- TOP CANDIDATES ----------------
  if ((r.topCandidates ?? []).length) {
    L.push('## 高分岗位', '');
    L.push('| 分数 | 岗位 | 公司 | 薪资 | 状态 |');
    L.push('|---:|---|---|---|---|');
    for (const c of r.topCandidates) {
      L.push(`| ${dash(c.score)} | ${dash(c.jobTitle)} | ${dash(c.company)} | ${dash(c.salary)} | ${c.contacted ? '已联系' : dash(c.state)} |`);
    }
    L.push('');
  }

  // ---------------- REMAINING ----------------
  const remaining = r.remainingCandidates ?? [];
  L.push('## 今日未联系的高质量候选', '');
  if (remaining.length) {
    L.push(`共 ${r.remainingCandidatesTotal ?? remaining.length} 个（未联系 ≠ 明天一定联系，候选池消费策略尚未实现）：`, '');
    for (const c of remaining) {
      L.push(`- ${c.score}｜${dash(c.jobTitle)}｜${dash(c.company)}｜${dash(c.salary)}`);
    }
  } else {
    L.push('没有未联系的高质量候选。');
  }
  L.push('');

  // ---------------- CONTACTED ----------------
  if ((r.contactedToday ?? []).length) {
    L.push('## 今日已联系岗位', '');
    for (const c of r.contactedToday) {
      L.push(
        `- ${c.time}｜${dash(c.jobTitle)}｜${dash(c.company)}｜Score ${dash(c.score)}｜来源 ${c.mode ?? '—'}｜话术策略 ${c.greetingStrategy ?? '—'}`,
      );
    }
    L.push('');
  }

  // ---------------- ISSUES ----------------
  L.push('## 异常与暂停', '');
  if ((r.issues ?? []).length) {
    for (const i of r.issues) {
      L.push(`- ${i.time}｜${i.type}｜${dash(i.title)}${i.detail ? `｜${i.detail}` : ''}`);
    }
  } else {
    L.push('No issues today.');
  }
  L.push('');

  // ---------------- 未监测能力（明确声明，而不是显示 0） ----------------
  L.push('## 尚未监测', '');
  L.push('- HR 回复 / 简历请求 / 简历发送 / 面试：本版本还没有对话监测能力，因此不显示这些数字。');
  L.push('');

  return L.join('\n');
}
