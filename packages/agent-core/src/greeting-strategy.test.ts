// V0.5 Phase 1：打招呼话术构建（greeting-builder.js）单元测试
// 原则：话术必须对用户可见、可修改、可固化；不可见话术不允许被自动发送。
import { describe, it, expect } from 'vitest';
import {
  GREETING_STRATEGY_MODES,
  buildGreetingMessage,
} from '../../../extension/greeting-builder.js';
import { DEFAULT_GREETING_TEMPLATE, MAX_GREETING_TEMPLATE_LENGTH } from '../../../extension/settings.js';

const strategy = (template: string, over: Record<string, unknown> = {}) => ({
  mode: 'template',
  templateId: 'default',
  template,
  ...over,
});

describe('buildGreetingMessage（template 模式）', () => {
  it('返回话术本体、策略与 metadata', () => {
    const r = buildGreetingMessage({
      job: { jobId: 'j-1', title: 'AI 产品经理', company: '某公司' },
      greetingStrategy: strategy('  你好，我想聊聊这个岗位。  '),
    });
    expect(r.message).toBe('你好，我想聊聊这个岗位。'); // trim 后发送
    expect(r.strategy).toEqual({ mode: 'template', templateId: 'default' });
    expect(r.metadata.jobId).toBe('j-1');
    expect(r.metadata.jobTitle).toBe('AI 产品经理');
    expect(r.metadata.templateId).toBe('default');
    expect(r.metadata.length).toBe(12);
    expect(r.metadata.personalizedFields).toEqual([]);
    expect(Number.isNaN(Date.parse(r.metadata.builtAt))).toBe(false);
  });

  it('未传 job 时 metadata 落 null，不抛错', () => {
    const r = buildGreetingMessage({ greetingStrategy: strategy('你好') });
    expect(r.metadata.jobId).toBeNull();
    expect(r.metadata.jobTitle).toBeNull();
    expect(r.message).toBe('你好');
  });

  it('templateId 缺省为 default', () => {
    const r = buildGreetingMessage({ greetingStrategy: { mode: 'template', template: '你好' } });
    expect(r.metadata.templateId).toBe('default');
    expect(r.strategy.templateId).toBe('default');
  });

  it('自定义 templateId 被原样保留（便于审计"当时发的是哪一版话术"）', () => {
    const r = buildGreetingMessage({
      greetingStrategy: strategy('你好', { templateId: 'tpl-2026-01' }),
    });
    expect(r.strategy.templateId).toBe('tpl-2026-01');
    expect(r.metadata.templateId).toBe('tpl-2026-01');
  });

  it('默认模板本身可用（用户不改也能跑）', () => {
    const r = buildGreetingMessage({ greetingStrategy: strategy(DEFAULT_GREETING_TEMPLATE) });
    expect(r.message).toBe(DEFAULT_GREETING_TEMPLATE);
    expect(r.metadata.length).toBe(DEFAULT_GREETING_TEMPLATE.length);
  });

  it('恰好达到长度上限仍可用，超 1 字即拒绝', () => {
    const ok = 'あ'.repeat(MAX_GREETING_TEMPLATE_LENGTH);
    expect(buildGreetingMessage({ greetingStrategy: strategy(ok) }).metadata.length).toBe(
      MAX_GREETING_TEMPLATE_LENGTH,
    );
    expect(() =>
      buildGreetingMessage({ greetingStrategy: strategy(ok + 'あ') }),
    ).toThrow(/greeting template 无效/);
  });
});

describe('buildGreetingMessage 拒绝不安全输入', () => {
  it('空话术 / 纯空白直接抛错（绝不发空消息）', () => {
    expect(() => buildGreetingMessage({ greetingStrategy: strategy('') })).toThrow(/greeting template 无效/);
    expect(() => buildGreetingMessage({ greetingStrategy: strategy('   ') })).toThrow(/greeting template 无效/);
  });

  it('缺少 greetingStrategy 时抛错而不是发送默认话术', () => {
    expect(() => buildGreetingMessage({})).toThrow(/greeting template 无效/);
  });

  it('jd_personalized 明确未实现（不允许不可见话术被自动发送）', () => {
    expect(() =>
      buildGreetingMessage({ greetingStrategy: { mode: 'jd_personalized', template: '你好' } }),
    ).toThrow(/尚未实现/);
  });

  it('未知策略模式抛错', () => {
    expect(() => buildGreetingMessage({ greetingStrategy: { mode: 'llm_freeform', template: '你好' } })).toThrow(
      /未知的 greeting strategy/,
    );
  });

  it('GREETING_STRATEGY_MODES 只声明 template 与 jd_personalized', () => {
    expect(GREETING_STRATEGY_MODES).toEqual(['template', 'jd_personalized']);
    expect(Object.isFrozen(GREETING_STRATEGY_MODES)).toBe(true);
  });

  it('控制字符话术被拒绝', () => {
    expect(() => buildGreetingMessage({ greetingStrategy: strategy('你好\u0007') })).toThrow(
      /greeting template 无效/,
    );
  });
});
