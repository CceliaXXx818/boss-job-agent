import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '@job-agent/config-loader';
import type { ProfileConfig, ScheduleConfig } from '@job-agent/config-loader';
import { classifyByRule, policyBucketFor } from '@job-agent/conversation-policy';
import { DEFAULT_POLICY_CONFIG } from '@job-agent/conversation-policy';
import type { PolicyConfig } from '@job-agent/conversation-policy';
import type { DailyReportData, ReportRow } from '@job-agent/daily-reporter';
import { renderReportCSV, renderReportMD } from '@job-agent/daily-reporter';
import { DEFAULT_RUBRIC, finalizeEvidence, hardFilter } from '@job-agent/job-matcher';
import type { ExtractedEvidence } from '@job-agent/job-matcher';
import { MockMarket, MockPlatformAdapter } from '@job-agent/platform-mock';
import type { MockJob } from '@job-agent/platform-mock';
import { SqliteStore } from '@job-agent/sqlite-store';
import type { ApplicationState, HrIntent } from '@job-agent/domain';
import { virtualClock } from '../clock';
import type { VirtualClock } from '../clock';
import { ActionGate } from '../services/action-gate';
import { AgentRepo } from '../store/repo';
import type { JobDetail } from '../ports/job-platform';

/**
 * P1 E2E：一个虚拟工作日的完整主链路（ARCHITECTURE §4.1 的确定性回放）。
 * 说明：本测试的"政策驱动器"以确定性代码执行 Agent 应做的决策序列（决策点=工具边界与三扇门）。
 * dsh 接入后，同一套工具函数交给模型调用（HARNESS_BINDING U1-U5 完成后），测试逻辑不变。
 */

const E2E_DIR = fileURLToPath(new URL('.', import.meta.url)); // packages/agent-core/src/e2e/
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url)); // e2e->src->agent-core->packages->root
const CATALOG_PATH = join(ROOT, 'fixtures', 'jobs', 'catalog.json');

interface CatalogFile {
  jobs: Array<MockJob & { evidence?: ExtractedEvidence }>;
}

function loadCatalog(): CatalogFile {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogFile;
}

interface ScenarioCtx {
  clock: VirtualClock;
  profile: ProfileConfig;
  schedule: ScheduleConfig;
  store: SqliteStore;
  repo: AgentRepo;
  adapter: MockPlatformAdapter;
  market: MockMarket;
  gate: ActionGate;
  catalog: CatalogFile;
}

function setup(): ScenarioCtx {
  const clock = virtualClock('2026-09-04T01:20:00.000Z'); // 上海 09:20
  const { config } = loadAppConfig(join(ROOT, 'config'));
  const store = SqliteStore.open(':memory:');
  store.migrate();
  const repo = new AgentRepo(store);
  const catalog = loadCatalog();
  const market = new MockMarket(catalog.jobs);
  const adapter = new MockPlatformAdapter(market, clock);
  const gate = new ActionGate(repo, { maxAttempts: 1 });
  return { clock, profile: config.profile, schedule: config.schedule, store, repo, adapter, market, gate, catalog };
}

function jdCoreOf(detail: JobDetail): string {
  const firstSentence = detail.description.split(/[。；;]/)[0] ?? detail.description;
  return firstSentence.slice(0, 24) || 'AI 产品方向';
}

describe('P1 E2E：虚拟工作日主链路（mock）', () => {
  it('搜索→硬过滤→评分→打招呼→HR回复→自动发简历/预设应答/升级人工→日报', async () => {
    const ctx = setup();
    const { clock, profile, schedule, repo, adapter, market, gate, catalog } = ctx;
    const day = clock.todayKey();
    const nowIso = () => clock.now().toISOString();

    // ---- 登录检查 ----
    const login = await adapter.checkLogin();
    expect(login.ok).toBe(true);

    // ---- 1) 搜索（双城市）+ 详情 + 落库（发现/去重）----
    const evidenceOf = (id: string): ExtractedEvidence | undefined =>
      catalog.jobs.find((j) => j.externalId === id)?.evidence;

    const discovered: string[] = [];
    for (const city of profile.target.cities) {
      const summaries = await adapter.searchJobs({ city, keywords: ['产品'] });
      for (const s of summaries) {
        const detail = await adapter.getJobDetail(s.externalId);
        repo.upsertCandidate({
          platform: 'mock', externalId: detail.externalId, url: detail.url,
          fingerprint: detail.jdFingerprint, title: detail.title, company: detail.company,
          city: detail.city, salaryText: detail.salaryText, salaryMinK: detail.salaryMinK,
          salaryMaxK: detail.salaryMaxK, tags: detail.tags, jobType: detail.jobType,
          description: detail.description, hrName: detail.hrName, dayKey: day, at: nowIso(),
        });
        const appId = repo.ensureApplication('mock', detail.externalId, nowIso());
        discovered.push(detail.externalId);
        // 硬过滤 → FILTERED 或 评分 → 分桶
        const hf = hardFilter(
          {
            targetCities: profile.target.cities,
            excludeCities: profile.exclude.cities,
            excludeJobTypes: profile.exclude.job_types,
            excludeWorkModes: profile.exclude.work_modes,
            targetJobTitles: profile.target.job_titles,
          },
          {
            title: detail.title, city: detail.city, jobType: detail.jobType,
            workMode: (catalog.jobs.find((j) => j.externalId === detail.externalId) as MockJob & { workMode?: string })
              .workMode,
            tags: detail.tags, description: detail.description,
          },
        );
        if (!hf.passed) {
          repo.transitionApplication(appId, 'FILTERED', nowIso(), {
            hard_filter_reason: hf.reason,
            decision: 'filtered',
            next_action: hf.reason,
          });
          continue;
        }
        const ev = evidenceOf(detail.externalId) ?? {
          dimScores: { direction: 0, ai_core: 0, project: 0, pm: 0, industry: 0, city_mode: 0 },
          matchedEvidence: [],
          risks: ['无证据（占位）'],
        };
        const out = finalizeEvidence(ev, DEFAULT_RUBRIC, schedule.score_buckets);
        if (out.bucket === 'hot' || out.bucket === 'apply') {
          repo.transitionApplication(appId, 'QUEUED', nowIso(), {
            score_total: out.scoreTotal,
            score_dims_json: JSON.stringify(out.scoreDims),
            evidence_json: JSON.stringify({
              matched_evidence: out.matchedEvidence,
              risks: out.risks,
              decision: 'auto_greet',
            }),
            rubric_version: out.rubricVersion,
            decision: 'auto_greet',
            next_action: '自动打招呼',
          });
        } else {
          repo.patchApplication(appId, nowIso(), {
            score_total: out.scoreTotal,
            score_dims_json: JSON.stringify(out.scoreDims),
            evidence_json: JSON.stringify({ matched_evidence: out.matchedEvidence, risks: out.risks, decision: 'review' }),
            rubric_version: out.rubricVersion,
            decision: out.bucket === 'reject' ? 'reject' : 'review',
            next_action: out.bucket === 'review' ? '人工确认列表' : '匹配不足不投递',
          });
        }
      }
    }

    expect(discovered.length).toBe(12); // 双城市目录共 12 条（北京/上海不在搜索范围）

    // ---- 2) 打招呼（自动：hot/apply 分桶，按分降序，配额内）----
    const queued = repo.store.db
      .prepare(
        `SELECT application_id, job_external_id, score_total FROM applications
         WHERE state = 'QUEUED' ORDER BY score_total DESC`,
      )
      .all() as Array<{ application_id: string; job_external_id: string; score_total: number }>;
    const appByJob = new Map(queued.map((q) => [q.job_external_id, q.application_id]));

    // 问候模板（t1，来自真实配置文件）
    const { config } = loadAppConfig(join(ROOT, 'config'));
    const t1 = config.messages.greeting_templates.find((t) => t.template_id === 't1')!;

    const greeted: string[] = [];
    for (const q of queued) {
      const detail = await adapter.getJobDetail(q.job_external_id);
      const text = t1.text.replace('{{jd_core_requirement}}', jdCoreOf(detail));
      const gateOut = await gate.execute(
        {
          actionType: 'send_greeting', platform: 'mock', targetRef: `job:${q.job_external_id}`,
          variant: 't1', payloadJson: JSON.stringify({ text }), dayKey: day,
          runId: `run_${day}_morning`, actor: 'agent', entityType: 'application', entityId: q.application_id,
          quota: { max: schedule.daily_maximum, takesQuota: true },
        },
        () => adapter.sendGreeting(q.job_external_id, text),
      );
      if (gateOut.kind !== 'executed') throw new Error(`greeting failed: ${JSON.stringify(gateOut)}`);
      repo.transitionApplication(q.application_id, 'GREETED', nowIso(), {
        greeted_at: nowIso(),
        greeting_template_id: 't1',
        greeting_text_snapshot: text,
        greeting_effect_id: gateOut.effectId ?? null,
      });
      greeted.push(q.job_external_id);
    }
    // 数量充足时不低于 daily_minimum（不凑数的场景在 P2 soak 覆盖）
    expect(greeted.length).toBeGreaterThanOrEqual(1);
    expect(market.countByKind('greeting')).toBe(greeted.length);

    // ---- 3) HR 回复推进：每人按脚本回一条；扫描→分类→策略执行 ----
    clock.advance(45 * 60 * 1000); // 10:05 扫描点
    const policyCfg: PolicyConfig = {
      autoSendIntents: config.messages.auto_send_intents as readonly HrIntent[],
      needsHumanIntents: config.messages.needs_human_intents as readonly HrIntent[],
    };
    const needsHuman: string[] = [];
    const hrReplied: string[] = [];
    let resumeSent = 0;
    let presetReplies = 0;

    const seenByConv = new Map<string, string | undefined>();
    for (const jobId of greeted) {
      market.replyByScript(jobId, nowIso());
    }
    for (const jobId of greeted) {
      const conv = market.getConversation(jobId);
      if (!conv) continue;
      const msgs = await adapter.getNewMessages(conv.conversationId, seenByConv.get(conv.conversationId));
      const appId = appByJob.get(jobId);
      if (!appId) continue;
      for (const m of msgs) {
        seenByConv.set(conv.conversationId, m.messageId);
        const cls = classifyByRule(m.text);
        const bucket = policyBucketFor(cls.intent, policyCfg);
        if (cls.intent !== 'unknown') hrReplied.push(`${jobId}:${cls.intent}`);
        switch (bucket) {
          case 'auto_send_resume': {
            const out = await gate.execute(
              {
                actionType: 'send_resume', platform: 'mock', targetRef: `conv:${conv.conversationId}`,
                variant: `online:${m.messageId.slice(-12)}`, payloadJson: JSON.stringify({ mode: 'online', msg: m.text }),
                dayKey: day, runId: `run_${day}_scan1`, actor: 'agent',
                entityType: 'application', entityId: appId,
                quota: { max: Number.MAX_SAFE_INTEGER, takesQuota: false },
              },
              () => adapter.sendResume(conv.conversationId, { mode: 'online' }),
            );
            expect(out.kind).toBe('executed');
            resumeSent++;
            repo.transitionApplication(appId, 'RESUME_SENT', nowIso(), { resume_sent_at: nowIso(), resume_mode: 'online' });
            break;
          }
          case 'auto_reply_preset': {
            const replyKey =
              cls.intent === 'availability_check' ? 'availability'
              : cls.intent === 'start_date_question' ? 'start_date'
              : cls.intent === 'location_confirm' ? 'location_confirm'
              : 'smalltalk';
            const preset = config.messages.preset_replies[replyKey];
            const out = await gate.execute(
              {
                actionType: 'send_template_reply', platform: 'mock', targetRef: `conv:${conv.conversationId}`,
                variant: replyKey, payloadJson: JSON.stringify({ text: preset.text }),
                dayKey: day, runId: `run_${day}_scan1`, actor: 'agent',
                entityType: 'application', entityId: appId,
                quota: { max: Number.MAX_SAFE_INTEGER, takesQuota: false },
              },
              () => adapter.sendTextReply(conv.conversationId, preset.text),
            );
            expect(out.kind).toBe('executed');
            presetReplies++;
            break;
          }
          case 'needs_human': {
            repo.transitionApplication(appId, 'NEEDS_HUMAN', nowIso(), { needs_human_reason: cls.intent });
            needsHuman.push(`${jobId}（${m.text}）`);
            break;
          }
        }
      }
    }

    // ---- 断言（P1 验收金标准）----
    expect(resumeSent).toBe(3); // 0001/0004(request_online_submit)/0014 明确索要简历
    expect(presetReplies).toBe(1); // 0003 在职状态 → 预设应答
    expect(needsHuman).toHaveLength(2); // 0002 薪资、0012 面试邀约 → 升级人工
    expect(market.countByKind('resume')).toBe(3);
    expect(market.countByKind('reply')).toBe(1);
    // 零重复：没有任何岗位被二次打招呼（效果数 = 唯一岗位数）
    const dupGreet = market.effects.filter((e) => e.kind === 'greeting');
    expect(new Set(dupGreet.map((e) => e.jobId)).size).toBe(dupGreet.length);
    // 审计与意图 1:1：greeting 全部 executed 且无 duplicate 记录
    const audits = repo.store.db.prepare(`SELECT result, COUNT(*) AS n FROM audit_log GROUP BY result`).all() as Array<{
      result: string;
      n: number;
    }>;
    const byResult = new Map(audits.map((a) => [a.result, Number(a.n)]));
    expect(byResult.get('duplicate') ?? 0).toBe(0);
    const greets = repo.store.db
      .prepare(`SELECT COUNT(*) AS n FROM action_intents WHERE action_type='send_greeting' AND state='executed'`)
      .all() as Array<{ n: number }>;
    expect(greets[0]?.n).toBe(greeted.length);

    // ---- 4) 日报（reports 临时目录）----
    interface SqlAppRow {
      external_id: string;
      company: string;
      title: string;
      city: string;
      state: ApplicationState;
      score_total: number | null;
      greeted_at: string | null;
      next_action: string | null;
    }
    const rawRows = repo.store.db
      .prepare(
        `SELECT a.job_external_id AS external_id, c.company, c.title, c.city, a.state, a.score_total,
                a.greeted_at, a.next_action
         FROM applications a JOIN candidate_jobs c
           ON c.platform = a.platform AND c.external_id = a.job_external_id
         ORDER BY a.score_total DESC`,
      )
      .all() as unknown as SqlAppRow[];
    const rows: ReportRow[] = rawRows.map((r) => ({
      platform: 'mock' as const,
      externalId: r.external_id,
      company: r.company,
      title: r.title,
      city: r.city,
      state: r.state,
      scoreTotal: r.score_total ?? undefined,
      greetedAt: r.greeted_at ?? undefined,
      nextAction: r.next_action ?? undefined,
    }));
    const filteredCount = Number(
      (repo.store.db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE state = 'FILTERED'`).all() as Array<{ n: number }>)[0]?.n ?? 0,
    );
    const topJobs = rows
      .filter((r): r is ReportRow & { scoreTotal: number } => typeof r.scoreTotal === 'number')
      .sort((a, b) => b.scoreTotal - a.scoreTotal)
      .slice(0, 5)
      .map((r) => ({ externalId: r.externalId, title: r.title, company: r.company, scoreTotal: r.scoreTotal }));

    const report: DailyReportData = {
      dayKey: day,
      counts: {
        discovered: discovered.length,
        hardPassed: discovered.length - filteredCount,
        ge75: greeted.length,
        greeted: greeted.length,
        hrReplied: hrReplied.length,
        resumeSent,
        needsHuman: needsHuman.length,
        failures: 0,
      },
      rows,
      needsHumanItems: needsHuman,
      anomalies: [],
      topJobs,
    };
    const md = renderReportMD(report);
    const csv = renderReportCSV(report);
    const dir = mkdtempSync(join(tmpdir(), 'job-agent-report-'));
    writeFileSync(join(dir, `${day}.md`), md);
    writeFileSync(join(dir, `${day}.csv`), csv);
    expect(md).toContain('已发送简历：3');
    expect(md).toContain('待人工处理：2');
    expect(md).toContain('AI产品经理');
    expect(csv.split('\n').length).toBeGreaterThan(5);

    // ---- 5) 暂停语义：登录失效 → 暂停后一切写操作拒绝 ----
    market.setLogin('logged_out');
    expect((await adapter.checkLogin()).ok).toBe(false);
    ctx.repo.setSetting('global_pause', { active: true, reason: 'logged_out' }, nowIso());
    let gateCalls = 0;
    const paused = await gate.execute(
      {
        actionType: 'send_greeting', platform: 'mock', targetRef: 'job:MOCK-9999', variant: 't1',
        payloadJson: '{}', dayKey: day, runId: `run_${day}`, actor: 'agent',
        quota: { max: 30, takesQuota: true },
      },
      async () => {
        gateCalls++;
        return { ok: true };
      },
    );
    expect(paused.kind).toBe('paused');
    expect(gateCalls).toBe(0);

    ctx.store.close();
  }, 30_000);
});
