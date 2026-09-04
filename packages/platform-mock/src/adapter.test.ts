import { describe, expect, it } from 'vitest';
import { virtualClock } from '@job-agent/agent-core';
import { MockMarket, MockPlatformAdapter } from './adapter';
import type { MockJob } from './adapter';

function twoJobs(): MockJob[] {
  return [
    {
      externalId: 'MOCK-1', title: 'AI产品经理', company: '甲公司', city: '深圳',
      salaryText: '30-40K', tags: [], description: 'LLM+RAG智能客服', hrName: '李HR',
      hrScript: 'request_resume',
    },
    {
      externalId: 'MOCK-2', title: '大模型产品经理', company: '乙公司', city: '杭州',
      salaryText: '30-40K', tags: [], description: '大模型产品', hrName: '王HR',
      hrScript: 'ask_salary',
    },
  ];
}

describe('MockPlatformAdapter（ARCHITECTURE §5.3 契约）', () => {
  it('searchJobs 按城市+关键词过滤并返回确定性指纹', async () => {
    const clock = virtualClock('2026-09-04T01:30:00.000Z');
    const a = new MockPlatformAdapter(new MockMarket(twoJobs()), clock);
    const sz = await a.searchJobs({ city: '深圳', keywords: ['AI产品经理'] });
    expect(sz).toHaveLength(1);
    expect(sz[0]?.externalId).toBe('MOCK-1');
    expect(sz[0]?.jdFingerprint).toBeTruthy();
    const none = await a.searchJobs({ city: '杭州', keywords: ['不存在'] });
    expect(none).toHaveLength(0);
  });

  it('打招呼一次成功；同岗位二次返回 ALREADY_GREETED（平台侧守卫）', async () => {
    const market = new MockMarket(twoJobs());
    const a = new MockPlatformAdapter(market);
    const r1 = await a.sendGreeting('MOCK-1', '您好，希望进一步沟通');
    expect(r1.ok).toBe(true);
    const r2 = await a.sendGreeting('MOCK-1', '您好，希望进一步沟通');
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe('ALREADY_GREETED');
    expect(market.countByKind('greeting')).toBe(1);
  });

  it('HR 脚本回复 → getNewMessages 增量拉取（水位线去重）', async () => {
    const clock = virtualClock('2026-09-04T01:30:00.000Z');
    const market = new MockMarket(twoJobs());
    const a = new MockPlatformAdapter(market, clock);
    await a.sendGreeting('MOCK-1', '您好…');
    market.replyByScript('MOCK-1', clock.now().toISOString());
    const conv = market.getConversation('MOCK-1')!;
    const all = await a.getNewMessages(conv.conversationId);
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toContain('简历');
    // 增量：带水位线再拉为空
    const after = await a.getNewMessages(conv.conversationId, all[0]?.messageId);
    expect(after).toHaveLength(0);
  });

  it('sendResume/sendTextReply 计入账本；异常注入：登录失效与页面变化', async () => {
    const clock = virtualClock('2026-09-04T01:30:00.000Z');
    const market = new MockMarket(twoJobs());
    const a = new MockPlatformAdapter(market, clock);
    await a.sendGreeting('MOCK-2', '您好…');
    const conv = market.getConversation('MOCK-2')!;
    const rs = await a.sendResume(conv.conversationId, { mode: 'online' });
    expect(rs.ok).toBe(true);
    expect(market.countByKind('resume')).toBe(1);

    market.setLogin('logged_out');
    expect((await a.checkLogin()).state).toBe('logged_out');
    market.setLogin('verification_required');
    expect((await a.checkLogin()).state).toBe('verification_required');
    market.setLogin('page_changed');
    await expect(a.getJobDetail('MOCK-1')).rejects.toThrow(/页面结构变化/);
  });
});
