import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@job-agent/sqlite-store';
import { classifyByRule, policyBucketFor, PRESET_REPLY_INTENTS } from '@job-agent/conversation-policy';
import { DEFAULT_POLICY_CONFIG } from '@job-agent/conversation-policy';
import { MockMarket, MockPlatformAdapter } from '@job-agent/platform-mock';
import type { MockJob } from '@job-agent/platform-mock';
import { virtualClock } from '../clock';
import { AgentRepo } from '../store/repo';
import { ActionGate } from './action-gate';
import { AutoActionExecutor } from './auto-actions';

const DAY = '2026-09-04';

function job(id: string, script: MockJob['hrScript']): MockJob {
  return {
    externalId: id, title: 'AI产品经理', company: `公司${id}`, city: '深圳', tags: [],
    description: 'LLM 智能客服产品', hrName: 'HR', hrScript: script,
  };
}

function setup(script: MockJob['hrScript']) {
  const clock = virtualClock('2026-09-04T01:30:00.000Z');
  const market = new MockMarket([job('MOCK-1', script)]);
  const adapter = new MockPlatformAdapter(market, clock);
  const store = SqliteStore.open(':memory:');
  store.migrate();
  const repo = new AgentRepo(store);
  const gate = new ActionGate(repo, { maxAttempts: 1 });
  const appId = repo.ensureApplication('mock', 'MOCK-1', clock.now().toISOString());
  repo.transitionApplication(appId, 'QUEUED', clock.now().toISOString(), { decision: 'auto_greet' });
  repo.transitionApplication(appId, 'GREETED', clock.now().toISOString(), { greeted_at: clock.now().toISOString() });
  const exec = new AutoActionExecutor(repo, adapter, gate, {
    classify: (t) => classifyByRule(t),
    policyFor: (i) => policyBucketFor(i, DEFAULT_POLICY_CONFIG),
    presetFor: (intent) =>
      PRESET_REPLY_INTENTS.has(intent)
        ? { key: intent, text: intent === 'availability_check' ? '在职。' : '您好，我在的，可以聊聊吗？' }
        : undefined,
  }, () => clock.now().toISOString());
  return { clock, market, adapter, store, repo, gate, appId, exec, nowIso: () => clock.now().toISOString() };
}

async function hrMessage(jobId: string, market: MockMarket, adapter: MockPlatformAdapter) {
  const conv = market.getConversation(jobId)!;
  const msgs = await adapter.getNewMessages(conv.conversationId);
  return { conv, msg: msgs[0]! };
}

describe('AutoActionExecutor（P2-④ 确定性兜底：模型可漏、系统不漏）', () => {
  it('明确索要简历 → 自动发送一次；重复处理被状态机拦截（零重复副作用）', async () => {
    const ctx = setup('request_resume');
    try {
      ctx.market.replyByScript('MOCK-1', ctx.nowIso());
      const { conv, msg } = await hrMessage('MOCK-1', ctx.market, ctx.adapter);
      const r1 = await ctx.exec.applyForMessage({
        jobId: 'MOCK-1', applicationId: ctx.appId, conversationId: conv.conversationId,
        message: msg, dayKey: DAY, runId: `run_${DAY}_scan`,
      });
      expect(r1.action).toBe('send_resume');
      expect(r1.outcome).toBe('executed');
      expect(ctx.market.countByKind('resume')).toBe(1);
      const r2 = await ctx.exec.applyForMessage({
        jobId: 'MOCK-1', applicationId: ctx.appId, conversationId: conv.conversationId,
        message: msg, dayKey: DAY, runId: `run_${DAY}_scan2`,
      });
      expect(r2.outcome).toBe('already_state'); // RESUME_SENT 状态机拦截
      expect(ctx.market.countByKind('resume')).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it('薪资话题 → escalate（needs_human），零外发；会话冻结', async () => {
    const ctx = setup('ask_salary');
    try {
      ctx.market.replyByScript('MOCK-1', ctx.nowIso());
      const { conv, msg } = await hrMessage('MOCK-1', ctx.market, ctx.adapter);
      const r = await ctx.exec.applyForMessage({
        jobId: 'MOCK-1', applicationId: ctx.appId, conversationId: conv.conversationId,
        message: msg, dayKey: DAY, runId: `run_${DAY}_scan`,
      });
      expect(r.action).toBe('escalate');
      expect(ctx.repo.applicationState(ctx.appId)).toBe('NEEDS_HUMAN');
      expect(ctx.market.countByKind('resume')).toBe(0);
      expect(ctx.market.countByKind('reply')).toBe(0);
      const convState = ctx.repo.store.db
        .prepare(`SELECT state FROM conversations WHERE conversation_id = ?`)
        .get(conv.conversationId) as { state: string };
      expect(convState.state).toBe('frozen_needs_human');
    } finally {
      ctx.store.close();
    }
  });

  it('在职状态 → 预设应答（内容来自配置，模型不生成答案）', async () => {
    const ctx = setup('availability');
    try {
      ctx.market.replyByScript('MOCK-1', ctx.nowIso());
      const { conv, msg } = await hrMessage('MOCK-1', ctx.market, ctx.adapter);
      const r = await ctx.exec.applyForMessage({
        jobId: 'MOCK-1', applicationId: ctx.appId, conversationId: conv.conversationId,
        message: msg, dayKey: DAY, runId: `run_${DAY}_scan`,
      });
      expect(r.action).toBe('send_template_reply');
      expect(r.outcome).toBe('executed');
      expect(ctx.market.countByKind('reply')).toBe(1);
      expect(ctx.market.effects.find((e) => e.kind === 'reply')?.text).toBe('在职。');
    } finally {
      ctx.store.close();
    }
  });
});
