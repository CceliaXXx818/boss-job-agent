import { describe, expect, it } from 'vitest';
import type { HrIntent } from '@job-agent/domain';
import { classifyByRule, policyBucketFor, DEFAULT_POLICY_CONFIG } from './classifier';

/** 语料（匿名）。P2 会扩展为 ≥200 条的黄金语料评测集（fixtures/hr/intent_corpus.csv）。 */
const CORPUS: Array<[string, HrIntent]> = [
  ['你好', 'greeting_smalltalk'],
  ['在吗？', 'greeting_smalltalk'],
  ['哈喽！', 'greeting_smalltalk'],
  ['在么', 'greeting_smalltalk'],
  ['发一下简历', 'request_resume'],
  ['可以看看你的简历吗', 'request_resume'],
  ['方便发个简历过来吗', 'request_resume'],
  ['简历发我一份吧', 'request_resume'],
  ['直接投递一下在线简历', 'request_online_submit'],
  ['你目前在职吗', 'availability_check'],
  ['现在还在职？', 'availability_check'],
  ['多久可以到岗', 'start_date_question'],
  ['最快什么时候能入职', 'start_date_question'],
  ['接受深圳吗', 'location_confirm'],
  ['在杭州方便吗', 'location_confirm'],
  ['你期望薪资多少', 'salary_discussion'],
  ['目前薪资多少', 'salary_discussion'],
  ['为什么从上家离职', 'reason_for_leaving'],
  ['明天下午方便面试吗', 'interview_invitation'],
  ['能约个时间面试聊聊吗', 'interview_invitation'],
  ['需要长期驻外出差', 'relocation_request'],
  ['要来北京工作可以吗', 'relocation_request'],
  ['提供一下身份证号', 'sensitive_data_request'],
  ['需要做背调，提供信息', 'offer_background_check'],
  ['Offer 的情况我们电话沟通', 'offer_background_check'],
  ['发你的银行卡号登记', 'sensitive_data_request'],
  ['你们这边还有什么想了解的', 'unknown'],
];

describe('conversation-policy: 意图分类（规则版）', () => {
  it.each(CORPUS)('「%s」→ %s', (text, expected) => {
    const r = classifyByRule(text);
    expect(r.intent).toBe(expected);
  });

  it('长句带上下文仍命中正确意图', () => {
    expect(classifyByRule('你好，我是XX公司的HR，看了你的简历，方便发一份 PDF 简历给我吗？谢谢').intent).toBe(
      'request_resume',
    );
    expect(classifyByRule('我们这边客户比较急，能接受长期驻外吗，base 北京').intent).toBe('relocation_request');
  });
});

describe('conversation-policy: 策略桶（TOOL_SPEC §5 矩阵）', () => {
  const cfg = DEFAULT_POLICY_CONFIG;
  it('明确索要简历 → auto_send_resume', () => {
    expect(policyBucketFor('request_resume', cfg)).toBe('auto_send_resume');
    expect(policyBucketFor('request_online_submit', cfg)).toBe('auto_send_resume');
  });
  it('预设可答 → auto_reply_preset', () => {
    for (const i of ['availability_check', 'start_date_question', 'location_confirm', 'greeting_smalltalk'] as const) {
      expect(policyBucketFor(i, cfg)).toBe('auto_reply_preset');
    }
  });
  it('敏感/复杂/未知 → needs_human（绝不擅自回复）', () => {
    for (const i of ['salary_discussion', 'reason_for_leaving', 'interview_invitation', 'relocation_request', 'sensitive_data_request', 'offer_background_check', 'unknown'] as const) {
      expect(policyBucketFor(i, cfg)).toBe('needs_human');
    }
  });
});
