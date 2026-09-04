import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '@job-agent/config-loader';
import { classifyByRule, policyBucketFor, PRESET_REPLY_INTENTS } from '@job-agent/conversation-policy';
import { DEFAULT_POLICY_CONFIG } from '@job-agent/conversation-policy';
import type { PolicyConfig } from '@job-agent/conversation-policy';
import { renderReportCSV, renderReportMD } from '@job-agent/daily-reporter';
import type { DailyReportData } from '@job-agent/daily-reporter';
import { MockMarket, MockPlatformAdapter } from '@job-agent/platform-mock';
import type { MockJob } from '@job-agent/platform-mock';
import { SqliteStore } from '@job-agent/sqlite-store';
import type { ApplicationState, HrIntent } from '@job-agent/domain';
import { virtualClock } from '../clock';
import type { VirtualClock } from '../clock';
import { ActionGate } from '../services/action-gate';
import { AutoActionExecutor } from '../services/auto-actions';
import { AgentRepo } from '../store/repo';
import type { JobDetail } from '../ports/job-platform';

/**
 * P2-② soak：5 个虚拟工作日（2026-09-07..11，Asia/Shanghai）。
 * 每日：市场新增 4 岗位 → 搜索/去重 → 评分入队 → 打招呼(配额) → HR 按脚本回复
 * → 执行器自动发简历/预设/升级；次日早晨对超期无回复(GREETED, noReply=1天)做 NO_REPLY。
 * 验收：0 重复、0 状态丢失、每日限额正确、日报连续 5 天、审计无 duplicate。
 */

const WEEKDAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const SCRIPTS = ['request_resume', 'ask_salary', 'silence', 'request_online_submit'] as const;
const CITIES = ['深圳', '杭州'];

function dayJobs(dayIdx: number, k: number): MockJob {
  const id = `W${dayIdx}-${k}`;
  return {
    externalId: id,
    title: 'AI产品经理',
    company: `每日新岗公司${dayIdx}-${k}`,
    city: CITIES[k % 2]!,
    salaryText: '30-45K',
    tags: [],
    description: `LLM 智能客服产品（每日新增岗位 ${id}）`,
    hrName: 'HR',
    hrScript: SCRIPTS[k % SCRIPTS.length]!,
  };
}

describe('P2-② soak：5 虚拟工作日（0 重复 / 0 状态丢失 / 限额 / 日报）', () => {
  it('连续 5 日运行满足全部不变量', async () => {
    const clock: VirtualClock = virtualClock(`${WEEKDAYS[0]}T01:20:00.000Z`);
    const { config } = loadAppConfig(join(process.cwd(), 'config'));
    const approvedTemplates = config.messages.greeting_templates.filter((t) => t.approved);
    const policyCfg: PolicyConfig = {
      autoSendIntents: config.messages.auto_send_intents as readonly HrIntent[],
      needsHumanIntents: config.messages.needs_human_intents as readonly HrIntent[],
    };

    const store = SqliteStore.open(':memory:');
    store.migrate();
    const repo = new AgentRepo(store);
    const market = new MockMarket([]);
    const adapter = new MockPlatformAdapter(market, clock);
    const gate = new ActionGate(repo, { maxAttempts: 1 });
    const executor = new AutoActionExecutor(
      repo, adapter, gate,
      {
        classify: (t) => classifyByRule(t),
        policyFor: (i) => policyBucketFor(i, policyCfg),
        presetFor: (intent) =>
          PRESET_REPLY_INTENTS.has(intent)
            ? { key: intent, text: intent === 'availability_check' ? '在职。' : '您好，我在的，可以聊聊吗？' }
            : undefined,
      },
      () => clock.now().toISOString(),
    );

    const reportDir = join(tmpdir(), `job-agent-soak-${Date.now()}`);
    mkdirSync(reportDir, { recursive: true });
    let greetCount = 0;
    const silentGreetedByDay = new Map<number, string[]>();
    const dailyGreeted = new Map<string, number>();

    for (let day = 0; day < WEEKDAYS.length; day++) {
      const dayKey = WEEKDAYS[day]!;
      clock.set(`${dayKey}T01:20:00.000Z`); // 09:20 开工前
      const nowIso = () => clock.now().toISOString();

      // ---- 早晨 1) NO_REPLY 扫描：GREETED 且超期（noReplyDays=1）----
      const cutoff = new Date(clock.now().getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const stale = repo.store.db
        .prepare(`SELECT application_id FROM applications WHERE state = 'GREETED' AND greeted_at < ?`)
        .all(cutoff) as Array<{ application_id: string }>;
      for (const s of stale) {
        repo.transitionApplication(s.application_id, 'NO_REPLY', nowIso(), { next_action: '无回复，标记暂无回复' });
      }

      // ---- 早晨 2) 投放当日新岗位并搜索 ----
      const batch = Array.from({ length: 4 }, (_, k) => dayJobs(day, k));
      market.addJobs(batch);
      const jobK = new Map(batch.map((j, k) => [j.externalId, k]));
      const queuedToday: Array<{ externalId: string; applicationId: string }> = [];
      for (const city of CITIES) {
        const summaries = await adapter.searchJobs({ city, keywords: ['产品'] });
        for (const s of summaries) {
          if (!s.externalId.startsWith(`W${day}-`)) continue; // 只处理当日新岗（旧岗走去重，不入队）
          const detail: JobDetail = await adapter.getJobDetail(s.externalId);
          repo.upsertCandidate({
            platform: 'mock', externalId: detail.externalId, url: detail.url,
            fingerprint: detail.jdFingerprint, title: detail.title, company: detail.company,
            city: detail.city, salaryText: detail.salaryText, tags: detail.tags,
            description: detail.description, hrName: detail.hrName, dayKey, at: nowIso(),
          });
          const appId = repo.ensureApplication('mock', detail.externalId, nowIso());
          queuedToday.push({ externalId: detail.externalId, applicationId: appId });
        }
      }
      expect(queuedToday).toHaveLength(4);

      // ---- 3) 评分入队（确定性满分 → 自动投递桶）→ 打招呼 ----
      const silentToday: string[] = [];
      for (const q of queuedToday) {
        repo.transitionApplication(q.applicationId, 'QUEUED', nowIso(), {
          decision: 'auto_greet', score_total: 90, rubric_version: 'soak',
        });
        const template = approvedTemplates[greetCount % approvedTemplates.length]!;
        const text = template.text
          .replace('{{jd_core_requirement}}', 'LLM智能客服')
          .replace('{{job_title}}', 'AI产品经理')
          .replace('{{evidence_project}}', 'LLM与RAG智能客服');
        const out = await gate.execute(
          {
            actionType: 'send_greeting', platform: 'mock', targetRef: `job:${q.externalId}`,
            variant: template.template_id, payloadJson: JSON.stringify({ text }), dayKey,
            runId: `run_${dayKey}_morning`, actor: 'cron', entityType: 'application', entityId: q.applicationId,
            quota: { max: config.schedule.daily_maximum, takesQuota: true },
          },
          () => adapter.sendGreeting(q.externalId, text),
        );
        if (out.kind !== 'executed') throw new Error(`greeting 失败: ${JSON.stringify(out)}`);
        greetCount++;
        repo.transitionApplication(q.applicationId, 'GREETED', nowIso(), {
          greeted_at: nowIso(), greeting_template_id: template.template_id, greeting_text_snapshot: text,
          greeting_effect_id: out.effectId ?? null,
        });
        const script = SCRIPTS[jobK.get(q.externalId)! % SCRIPTS.length]!;
        if (script === 'silence') silentToday.push(q.externalId);
      }
      silentGreetedByDay.set(day, silentToday);
      dailyGreeted.set(dayKey, queuedToday.length);

      // ---- 4) 10:05 扫描：HR 脚本回复 → 执行器 ----
      clock.advance(45 * 60 * 1000);
      for (const q of queuedToday) {
        const script = SCRIPTS[jobK.get(q.externalId)! % SCRIPTS.length]!;
        if (script === 'silence') continue;
        market.replyByScript(q.externalId, nowIso());
        const conv = market.getConversation(q.externalId)!;
        const msgs = await adapter.getNewMessages(conv.conversationId);
        for (const m of msgs) {
          await executor.applyForMessage({
            jobId: q.externalId, applicationId: q.applicationId, conversationId: conv.conversationId,
            message: m, dayKey, runId: `run_${dayKey}_scan1`,
          });
        }
      }

      // ---- 5) 日报（当日派生）----
      const appCount = (repo.store.db.prepare(`SELECT COUNT(*) AS n FROM applications`).all() as Array<{ n: number }>)[0]?.n ?? 0;
      const needsHumanCount = (repo.store.db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE state = 'NEEDS_HUMAN'`).all() as Array<{ n: number }>)[0]?.n ?? 0;
      const rowsRaw = repo.store.db
        .prepare(`SELECT a.job_external_id AS id, a.state FROM applications a WHERE a.state <> 'FILTERED' ORDER BY a.application_id`)
        .all() as unknown as Array<{ id: string; state: ApplicationState }>;
      const report: DailyReportData = {
        dayKey,
        counts: {
          discovered: Number(appCount),
          hardPassed: rowsRaw.length, ge75: queuedToday.length, greeted: queuedToday.length,
          hrReplied: market.effects.filter((e) => e.kind === 'resume' || e.kind === 'reply').length,
          resumeSent: market.effects.filter((e) => e.kind === 'resume').length,
          needsHuman: Number(needsHumanCount),
          failures: 0,
        },
        rows: rowsRaw.map((r) => ({ platform: 'mock' as const, externalId: r.id, company: '', title: r.id, city: '', state: r.state })),
        needsHumanItems: [], anomalies: [], topJobs: [],
      };
      writeFileSync(join(reportDir, `${dayKey}.md`), renderReportMD(report));
      writeFileSync(join(reportDir, `${dayKey}.csv`), renderReportCSV(report));
    }

    // ---- 终局断言 ----
    // A. 零重复：效果数与唯一岗位数一致；无 audit duplicate
    const greetEffects = market.effects.filter((e) => e.kind === 'greeting');
    expect(new Set(greetEffects.map((e) => e.jobId)).size).toBe(greetEffects.length);
    const dupAudits = repo.store.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE result='duplicate'`).all() as Array<{ n: number }>;
    expect(dupAudits[0]?.n).toBe(0);

    // B. 总岗位数与状态完整（20 新岗、无非法/空状态）
    const apps = repo.store.db
      .prepare(`SELECT state, COUNT(*) AS n FROM applications GROUP BY state`)
      .all() as Array<{ state: ApplicationState; n: number }>;
    const totalApps = apps.reduce((a, b) => a + Number(b.n), 0);
    expect(totalApps).toBe(20);
    expect(apps.every((a) => ['GREETED', 'RESUME_SENT', 'NEEDS_HUMAN', 'NO_REPLY', 'QUEUED', 'DISCOVERED', 'FAILED', 'FILTERED'].includes(a.state))).toBe(true);

    // C. 每日限额准确（每天恰好 4 次占额执行）
    for (const dayKey of WEEKDAYS) {
      expect(repo.usedQuota('mock', 'send_greeting', dayKey)).toBe(4);
    }

    // D. NO_REPLY：D0..D2 的静默岗位在下游早晨被正确标记（noReplyDays=1 时约滞后 2 天生效；D3 当天仍为 GREETED）
    const noReplyIds = new Set(
      (repo.store.db.prepare(`SELECT job_external_id FROM applications WHERE state='NO_REPLY'`).all() as Array<{ job_external_id: string }>).map((r) => r.job_external_id),
    );
    for (let day = 0; day < 3; day++) {
      for (const id of silentGreetedByDay.get(day) ?? []) {
        expect(noReplyIds.has(id)).toBe(true);
      }
    }
    const day3SilentId = silentGreetedByDay.get(3)?.[0];
    if (day3SilentId) {
      const st = repo.store.db.prepare(`SELECT state FROM applications WHERE job_external_id = ?`).get(day3SilentId) as { state: ApplicationState };
      expect(st.state).toBe('GREETED'); // 尚未超期，保持等待
    }
    // E. 日报文件 5 天 × MD+CSV
    for (const dayKey of WEEKDAYS) {
      expect(existsSync(join(reportDir, `${dayKey}.md`))).toBe(true);
      expect(existsSync(join(reportDir, `${dayKey}.csv`))).toBe(true);
    }
    // F. 审计不可变仍然成立
    expect(() => store.db.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/);

    store.close();
  }, 60_000);
});
