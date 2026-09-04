import { APPLICATION_STATE_LABELS } from '@job-agent/domain';
import type { ApplicationState, PlatformId } from '@job-agent/domain';

/** 日报渲染 —— PRD 第八节 / TOOL_SPEC #19。数据全部由调用方汇总传入（派生，无模型生成）。 */

export interface ReportCounts {
  discovered: number;
  hardPassed: number;
  ge75: number;
  greeted: number;
  hrReplied: number;
  resumeSent: number;
  needsHuman: number;
  failures: number;
}

export interface ReportRow {
  platform: PlatformId;
  externalId: string;
  company: string;
  title: string;
  city: string;
  scoreTotal?: number;
  greetedAt?: string;
  state: ApplicationState;
  hrReply?: string;
  nextAction?: string;
}

export interface DailyReportData {
  dayKey: string;
  counts: ReportCounts;
  rows: ReportRow[];
  needsHumanItems: string[];
  anomalies: string[];
  topJobs: { externalId: string; title: string; company: string; scoreTotal: number }[];
}

function stateZh(state: ApplicationState): string {
  return APPLICATION_STATE_LABELS[state] ?? state;
}

export function renderReportMD(d: DailyReportData): string {
  const lines: string[] = [];
  lines.push(`# 投递日报 ${d.dayKey}`, '');
  lines.push('## 汇总', '');
  lines.push(`- 发现新岗位：${d.counts.discovered}`);
  lines.push(`- 通过硬条件：${d.counts.hardPassed}`);
  lines.push(`- 匹配度≥${75}：${d.counts.ge75}`);
  lines.push(`- 主动沟通：${d.counts.greeted}`);
  lines.push(`- HR回复：${d.counts.hrReplied}`);
  lines.push(`- 已发送简历：${d.counts.resumeSent}`);
  lines.push(`- 待人工处理：${d.counts.needsHuman}`);
  lines.push(`- 执行失败：${d.counts.failures}`, '');
  lines.push('## 岗位明细', '');
  lines.push('| 公司 | 岗位 | 城市 | 匹配度 | 当前进度 | HR回复 | 下一步 |');
  lines.push('|---|---|---:|---|---|---|---|');
  for (const r of d.rows) {
    lines.push(
      `| ${r.company} | ${r.title} | ${r.city} | ${r.scoreTotal ?? '—'} | ${stateZh(r.state)} | ${r.hrReply ?? '—'} | ${r.nextAction ?? '—'} |`,
    );
  }
  lines.push('', '## 等待人工处理', '');
  lines.push(d.needsHumanItems.length ? d.needsHumanItems.map((s) => `- ${s}`).join('\n') : '- 无', '');
  lines.push('## 当日异常', '');
  lines.push(d.anomalies.length ? d.anomalies.map((s) => `- ${s}`).join('\n') : '- 无', '');
  return lines.join('\n');
}

export function renderReportCSV(d: DailyReportData): string {
  const header = '公司,岗位,城市,匹配度,当前状态,HR回复,下一步';
  const rows = d.rows.map((r) =>
    [r.company, r.title, r.city, r.scoreTotal ?? '', stateZh(r.state), r.hrReply ?? '', r.nextAction ?? '']
      .map((c) => `"${String(c).replaceAll('"', '""')}"`)
      .join(','),
  );
  return [header, ...rows].join('\n');
}
