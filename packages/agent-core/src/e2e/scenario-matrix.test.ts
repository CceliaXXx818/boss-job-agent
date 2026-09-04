import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@job-agent/sqlite-store';
import { MockMarket, MockPlatformAdapter } from '@job-agent/platform-mock';
import type { MockJob } from '@job-agent/platform-mock';
import { classifyByRule, policyBucketFor, PRESET_REPLY_INTENTS } from '@job-agent/conversation-policy';
import { DEFAULT_POLICY_CONFIG } from '@job-agent/conversation-policy';
import { virtualClock } from '../clock';
import type { VirtualClock } from '../clock';
import { AgentRepo } from '../store/repo';
import { ActionGate } from '../services/action-gate';
import { AutoActionExecutor } from '../services/auto-actions';

const DAY = '2026-09-04';

function job(id: string, script: MockJob['hrScript']): MockJob {
  return {
    externalId: id, title: 'AI产品经理', company: `公司${id}`, city: '深圳', tags: [],
    description: 'LLM 智能客服产品', hrName: 'HR', hrScript: script,
  };
}

interface Ctx {
  clock: VirtualClock;
  store: SqliteStore;
  repo: AgentRepo;
  market: MockMarket;
  adapter: MockPlatformAdapter;
  gate: ActionGate;
  nowIso: () => string;
}

function ctx(jobs: MockJob[]): Ctx {
  const clock: VirtualClock = virtualClock('2026-09-04T01:30:00.000Z');
  const store = SqliteStore.open(':memory:');
  store.migrate();
  const repo = new AgentRepo(store);
  const market = new MockMarket(jobs);
  const adapter = new MockPlatformAdapter(market, clock);
  const gate = new ActionGate(repo, { maxAttempts: 1 });
  return { clock, store, repo, market, adapter, gate, nowIso: () => clock.now().toISOString() };
}

async function greet(ctx: Ctx, id: string, max: number, extra: object = {}) {
  const appId = ctx.repo.ensureApplication('mock', id, ctx.nowIso());
  ctx.repo.transitionApplication(appId, 'QUEUED', ctx.nowIso(), { decision: 'auto_greet' });
  const out = await ctx.gate.execute(
    {
      actionType: 'send_greeting', platform: 'mock', targetRef: `job:${id}`, variant: 't1',
      payloadJson: JSON.stringify({ text: '您好…' }), dayKey: DAY, runId: `run_${DAY}`, actor: 'agent',
      entityType: 'application', entityId: appId, quota: { max, takesQuota: true }, ...extra,
    },
    () => ctx.adapter.sendGreeting(id, '您好…'),
  );
  if (out.kind === 'executed') {
    ctx.repo.transitionApplication(appId, 'GREETED', ctx.nowIso(), { greeted_at: ctx.nowIso() });
  }
  return { appId, out };
}

describe('P2-③ 场景矩阵（mock）', () => {
  it('quota-day：每日上限=1，第二岗位打招呼被 QUOTA_EXHAUSTED 拒绝且零副作用', async () => {
    const c = ctx([job('Q1', 'silence'), job('Q2', 'silence')]);
    try {
      const a = await greet(c, 'Q1', 1);
      expect(a.out.kind).toBe('executed');
      const b = await greet(c, 'Q2', 1);
      expect(b.out.kind).toBe('quota_exhausted');
      expect(c.market.countByKind('greeting')).toBe(1);
      expect(c.repo.usedQuota('mock', 'send_greeting', DAY)).toBe(1);
    } finally {
      c.store.close();
    }
  });

  it('pause-day：登录失效并全局暂停后，写操作一律 PAUSED、市场零新增效果', async () => {
    const c = ctx([job('P1', 'silence')]);
    try {
      await greet(c, 'P1', 10);
      c.market.setLogin('verification_required');
      const login = await c.adapter.checkLogin();
      expect(login.ok).toBe(false);
      expect(login.state).toBe('verification_required');
      c.repo.setSetting('global_pause', { active: true, reason: 'verification_required' }, c.nowIso());
      let calls = 0;
      const out = await c.gate.execute(
        {
          actionType: 'send_greeting', platform: 'mock', targetRef: 'job:P2', variant: 't1',
          payloadJson: '{}', dayKey: DAY, runId: `run_${DAY}`, actor: 'agent',
          quota: { max: 10, takesQuota: true },
        },
        async () => {
          calls++;
          return { ok: true };
        },
      );
      expect(out.kind).toBe('paused');
      expect(calls).toBe(0);
      expect(c.market.countByKind('greeting')).toBe(1); // 暂停后无新增
    } finally {
      c.store.close();
    }
  });

  it('sensitive-day：只出现薪资/背调/面试话题时零外发、全部升级人工', async () => {
    const c = ctx([job('S1', 'ask_salary'), job('S2', 'invite')]);
    try {
      const g1 = await greet(c, 'S1', 10);
      const g2 = await greet(c, 'S2', 10);
      const executor = new AutoActionExecutor(
        c.repo, c.adapter, c.gate,
        {
          classify: (t) => classifyByRule(t),
          policyFor: (i) => policyBucketFor(i, DEFAULT_POLICY_CONFIG),
          presetFor: (intent) =>
            PRESET_REPLY_INTENTS.has(intent)
              ? { key: intent, text: intent === 'availability_check' ? '在职。' : '您好，我在的，可以聊聊吗？' }
              : undefined,
        },
        c.nowIso,
      );
      c.market.replyByScript('S1', c.nowIso());
      c.market.replyByScript('S2', c.nowIso());
      for (const [id, appId] of [
        ['S1', g1.appId],
        ['S2', g2.appId],
      ] as const) {
        const conv = c.market.getConversation(id)!;
        const msgs = await c.adapter.getNewMessages(conv.conversationId);
        for (const m of msgs) {
          const r = await executor.applyForMessage({
            jobId: id, applicationId: appId, conversationId: conv.conversationId,
            message: m, dayKey: DAY, runId: `run_${DAY}_scan`,
          });
          expect(r.action).toBe('escalate'); // 薪资/面试邀约一律升级
        }
      }
      expect(c.market.countByKind('resume')).toBe(0);
      expect(c.market.countByKind('reply')).toBe(0);
      const rows = c.repo.store.db
        .prepare(`SELECT state FROM applications ORDER BY job_external_id`)
        .all() as Array<{ state: string }>;
      expect(rows.map((r) => r.state)).toEqual(['NEEDS_HUMAN', 'NEEDS_HUMAN']);
      expect(c.market.countByKind('greeting')).toBe(2); // 只有打招呼是外发
    } finally {
      c.store.close();
    }
  });
});
