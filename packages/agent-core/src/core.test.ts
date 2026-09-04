import { describe, expect, it } from 'vitest';
import { APPLICATION_STATES, TERMINAL_APPLICATION_STATES } from '@job-agent/domain';
import {
  APPLICATION_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  validateTransitionTable,
} from './model/application-state';
import { localDateKey, virtualClock } from './clock';
import { buildIdemKey } from './idempotency';

describe('状态机（DATA_MODEL §3.2 执行版）', () => {
  it('迁移表自检无问题（目标合法且无自环）', () => {
    expect(validateTransitionTable()).toEqual([]);
  });

  it('每状态都定义了迁移边', () => {
    for (const s of APPLICATION_STATES) {
      expect(APPLICATION_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('关键主链路：DISCOVERED→QUEUED→GREETED→RESUME_SENT→NO_REPLY', () => {
    expect(canTransition('DISCOVERED', 'QUEUED')).toBe(true);
    expect(canTransition('QUEUED', 'GREETED')).toBe(true);
    expect(canTransition('GREETED', 'RESUME_SENT')).toBe(true);
    expect(canTransition('RESUME_SENT', 'NO_REPLY')).toBe(true);
  });

  it('硬过滤与敏感升级路径', () => {
    expect(canTransition('DISCOVERED', 'FILTERED')).toBe(true);
    expect(canTransition('GREETED', 'NEEDS_HUMAN')).toBe(true);
  });

  it('非法迁移抛 StateTransitionError；跳跃（DISCOVERED→RESUME_SENT）被拒', () => {
    expect(() => assertTransition('DISCOVERED', 'RESUME_SENT')).toThrow(/非法状态迁移/);
    expect(() => assertTransition('FILTERED', 'QUEUED')).toThrow(/非法状态迁移/);
  });

  it('终态不可继续自动推进', () => {
    expect(isTerminal('FILTERED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(TERMINAL_APPLICATION_STATES.has('GREETED')).toBe(false);
  });
});

describe('Clock（可回放 A9）', () => {
  it('虚拟时钟 todayKey 按 Asia/Shanghai 计算', () => {
    const c = virtualClock('2026-09-03T17:30:00.000Z'); // 上海已是 09-04 01:30
    expect(c.todayKey()).toBe('2026-09-04');
    expect(localDateKey(new Date('2026-09-03T16:00:00.000Z'))).toBe('2026-09-04'); // 上海 09-04 00:00
  });

  it('advance 推进时间并影响 todayKey', () => {
    const c = virtualClock('2026-09-04T00:30:00.000Z'); // 上海 09-04 08:30
    c.advance(60 * 60 * 1000); // +1h → 上海 09:30
    expect(c.todayKey()).toBe('2026-09-04');
    c.advance(16 * 24 * 60 * 60 * 1000);
    expect(c.todayKey()).toBe('2026-09-20');
  });
});

describe('幂等键（DATA_MODEL §6）', () => {
  it('问候幂等键含 template 变体', () => {
    expect(
      buildIdemKey({ actionType: 'send_greeting', platform: 'mock', targetRef: 'job:MOCK-1', variant: 't1', dayKey: '2026-09-04' }),
    ).toBe('send_greeting:mock:job:MOCK-1:t1:2026-09-04');
  });

  it('同日同参数幂等键相等；换日不同', () => {
    const a = buildIdemKey({ actionType: 'send_greeting', platform: 'mock', targetRef: 'job:MOCK-1', variant: 't1', dayKey: '2026-09-04' });
    const b = buildIdemKey({ actionType: 'send_greeting', platform: 'mock', targetRef: 'job:MOCK-1', variant: 't1', dayKey: '2026-09-05' });
    expect(a).not.toBe(b);
  });
});
