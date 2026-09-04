import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '@job-agent/config-loader';
import { classifyByRule, policyBucketFor, PRESET_REPLY_INTENTS } from '@job-agent/conversation-policy';
import { DEFAULT_POLICY_CONFIG } from '@job-agent/conversation-policy';
import { renderReportCSV, renderReportMD } from '@job-agent/daily-reporter';
import type { DailyReportData } from '@job-agent/daily-reporter';
import { DEFAULT_RUBRIC, finalizeEvidence, hardFilter } from '@job-agent/job-matcher';
import type { ExtractedEvidence } from '@job-agent/job-matcher';
import { MockMarket, MockPlatformAdapter } from '@job-agent/platform-mock';
import type { MockJob } from '@job-agent/platform-mock';
import { SqliteStore } from '@job-agent/sqlite-store';
import { virtualClock } from '../clock';
import { ActionGate } from '../services/action-gate';
import { AutoActionExecutor } from '../services/auto-actions';
import { AgentRepo } from '../store/repo';

/**
 * demo:day —— 本地一键演示：1 个虚拟工作日（Mock，无网络）。
 * 输出 reports/demo-2026-09-04.md|csv。
 * 说明：演示运行的是确定性政策驱动器；dsh 接入后，Agent 将以同一工具面驱动（HARNESS_BINDING）。
 */
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const DAY = '2026-09-04';

describe('demo:day（npm run demo:day）', () => {
  it('运行一个虚拟工作日并产出日报文件', async () => {
    const clock = virtualClock(`${DAY}T01:20:00.000Z`);
    const nowIso = () => clock.now().toISOString();
    const { config } = loadAppConfig(join(ROOT, 'config'));
    const store = SqliteStore.open(':memory:');
    store.migrate();
    const repo = new AgentRepo(store);
    const catalog = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'jobs', 'catalog.json'), 'utf8')) as {
      jobs: Array<{
        externalId: string;
        title: string;
        company: string;
        city: string;
        jobType?: string;
        workMode?: string;
        tags: string[];
        description: string;
        hrName?: string;
        hrScript: string;
        evidence?: { dimScores: Record<string, number>; matchedEvidence: unknown[]; risks: string[] };
      }>;
    };
    const mockJobs: MockJob[] = catalog.jobs.map(({ evidence: _ev, ...rest }) => rest as MockJob);
    const market = new MockMarket(mockJobs);
    const adapter = new MockPlatformAdapter(market, clock);
    const gate = new ActionGate(repo, { maxAttempts: 1 });
    const templates = config.messages.greeting_templates.filter((t) => t.approved);
    const executor = new AutoActionExecutor(
      repo, adapter, gate,
      {
        classify: (t) => classifyByRule(t),
        policyFor: (i) => policyBucketFor(i, DEFAULT_POLICY_CONFIG),
        presetFor: (intent) =>
          PRESET_REPLY_INTENTS.has(intent)
            ? { key: intent, text: intent === 'availability_check' ? '在职。' : '您好，我在的，可以聊聊吗？' }
            : undefined,
      },
      nowIso,
    );

    let greeted = 0;
    const greetedIds: string[] = [];
    let greetIdx = 0;
    for (const city of config.profile.target.cities) {
      const summaries = await adapter.searchJobs({ city, keywords: ['产品'] });
      for (const s of summaries) {
        const d = await adapter.getJobDetail(s.externalId);
        const entry = catalog.jobs.find((j) => j.externalId === d.externalId)!;
        repo.upsertCandidate({
          platform: 'mock', externalId: d.externalId, url: d.url, fingerprint: d.jdFingerprint,
          title: d.title, company: d.company, city: d.city, salaryText: d.salaryText,
          salaryMinK: d.salaryMinK, salaryMaxK: d.salaryMaxK, tags: d.tags, jobType: d.jobType,
          description: d.description, hrName: d.hrName, dayKey: DAY, at: nowIso(),
        });
        const appId = repo.ensureApplication('mock', d.externalId, nowIso());
        const hf = hardFilter(
          {
            targetCities: config.profile.target.cities,
            excludeCities: config.profile.exclude.cities,
            excludeJobTypes: config.profile.exclude.job_types,
            excludeWorkModes: config.profile.exclude.work_modes,
            targetJobTitles: config.profile.target.job_titles,
          },
          { title: d.title, city: d.city, jobType: d.jobType, workMode: entry.workMode, tags: d.tags, description: d.description },
        );
        if (!hf.passed) {
          repo.transitionApplication(appId, 'FILTERED', nowIso(), { hard_filter_reason: hf.reason, decision: 'filtered' });
          continue;
        }
        const ev = (entry.evidence ?? {
          dimScores: { direction: 0, ai_core: 0, project: 0, pm: 0, industry: 0, city_mode: 0 },
          matchedEvidence: [],
          risks: ['无证据'],
        }) as ExtractedEvidence;
        const out = finalizeEvidence(ev, DEFAULT_RUBRIC, config.schedule.score_buckets);
        if (out.bucket === 'hot' || out.bucket === 'apply') {
          repo.transitionApplication(appId, 'QUEUED', nowIso(), { decision: 'auto_greet', score_total: out.scoreTotal, rubric_version: out.rubricVersion });
          const t = templates[greetIdx % templates.length]!;
          greetIdx++;
          const text = t.text
            .replace('{{jd_core_requirement}}', 'LLM与RAG智能客服')
            .replace('{{job_title}}', d.title)
            .replace('{{evidence_project}}', 'LLM与RAG智能客服');
          const out2 = await gate.execute(
            {
              actionType: 'send_greeting', platform: 'mock', targetRef: `job:${d.externalId}`,
              variant: t.template_id, payloadJson: JSON.stringify({ text }), dayKey: DAY,
              runId: `run_${DAY}_demo`, actor: 'system', entityType: 'application', entityId: appId,
              quota: { max: config.schedule.daily_maximum, takesQuota: true },
            },
            () => adapter.sendGreeting(d.externalId, text),
          );
          if (out2.kind !== 'executed') throw new Error(`greet 失败 ${JSON.stringify(out2)}`);
          repo.transitionApplication(appId, 'GREETED', nowIso(), {
            greeted_at: nowIso(), greeting_template_id: t.template_id, greeting_text_snapshot: text,
            greeting_effect_id: out2.effectId ?? null,
          });
          greeted++;
          greetedIds.push(d.externalId);
        } else {
          repo.patchApplication(appId, nowIso(), {
            score_total: out.scoreTotal, decision: out.bucket === 'reject' ? 'reject' : 'review', next_action: '人工确认列表',
          });
        }
      }
    }

    clock.advance(45 * 60 * 1000);
    let resumeSent = 0;
    let needsHuman = 0;
    for (const id of greetedIds) {
      market.replyByScript(id, nowIso());
      const conv = market.getConversation(id)!;
      const msgs = await adapter.getNewMessages(conv.conversationId);
      const appRow = repo.findApplication('mock', id)!;
      for (const m of msgs) {
        const r = await executor.applyForMessage({
          jobId: id, applicationId: appRow.application_id, conversationId: conv.conversationId,
          message: m, dayKey: DAY, runId: `run_${DAY}_demo`,
        });
        if (r.action === 'send_resume' && r.outcome === 'executed') resumeSent++;
        if (r.action === 'escalate') needsHuman++;
      }
    }

    const reportDir = join(ROOT, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const rows = (repo.store.db
      .prepare(`SELECT c.company, c.title, c.city, a.state, a.score_total FROM applications a JOIN candidate_jobs c ON c.platform=a.platform AND c.external_id=a.job_external_id`)
      .all() as Array<{ company: string; title: string; city: string; state: string; score_total: number | null }>)
      .map((r) => ({
        platform: 'mock' as const,
        externalId: r.title,
        company: r.company,
        title: r.title,
        city: r.city,
        state: r.state as never,
        scoreTotal: r.score_total ?? undefined,
      }));
    const report: DailyReportData = {
      dayKey: DAY,
      counts: {
        discovered: rows.length,
        hardPassed: rows.filter((r) => r.state !== 'FILTERED').length,
        ge75: greeted,
        greeted,
        hrReplied: greeted,
        resumeSent,
        needsHuman,
        failures: 0,
      },
      rows,
      needsHumanItems: [],
      anomalies: [],
      topJobs: [],
    };
    const md = renderReportMD(report);
    const csv = renderReportCSV(report);
    writeFileSync(join(reportDir, `demo-${DAY}.md`), md);
    writeFileSync(join(reportDir, `demo-${DAY}.csv`), csv);
    console.log(`\n[demo:day] 打招呼 ${greeted}，自动发简历 ${resumeSent}，升级人工 ${needsHuman}`);
    console.log(`[demo:day] 报告: reports/demo-${DAY}.md / .csv\n`);
    expect(greeted).toBeGreaterThan(0);
    expect(resumeSent).toBeGreaterThan(0);
    expect(needsHuman).toBeGreaterThan(0);
    store.close();
  }, 30_000);
});
