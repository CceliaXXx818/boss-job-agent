import { describe, expect, it } from 'vitest';
import { APPLICATION_STATES } from '@job-agent/domain';
import type { ApplicationState, ActionType } from '@job-agent/domain';
import { assertTransition, canTransition, validateTransitionTable } from './model/application-state';
import { buildIdemKey } from './idempotency';

/** 简单确定性伪随机（测试用，固定种子可复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('P2-⑤ 属性测试', () => {
  it('状态机属性：任意 500 对随机迁移，canTransition 与 assertTransition 完全一致', () => {
    const rnd = mulberry32(20260904);
    expect(validateTransitionTable()).toEqual([]);
    for (let i = 0; i < 500; i++) {
      const from = APPLICATION_STATES[Math.floor(rnd() * APPLICATION_STATES.length)] as ApplicationState;
      const to = APPLICATION_STATES[Math.floor(rnd() * APPLICATION_STATES.length)] as ApplicationState;
      const can = canTransition(from, to);
      let threw = false;
      try {
        assertTransition(from, to);
      } catch {
        threw = true;
      }
      expect(threw).toBe(!can);
    }
  });

  it('状态机属性：FILTERED 无出边；FAILED 仅允许人工复位到 QUEUED', () => {
    for (const t of APPLICATION_STATES) {
      expect(canTransition('FILTERED', t), `FILTERED->${t}`).toBe(false);
    }
    const failedOut = APPLICATION_STATES.filter((t) => canTransition('FAILED', t));
    expect(failedOut).toEqual(['QUEUED']); // 人工复位重试（DATA_MODEL §3.2 注释）
  });

  it('幂等键属性：同一输入必得同一键；任一分量变化即得不同键', () => {
    const base = {
      actionType: 'send_greeting' as const,
      platform: 'mock',
      targetRef: 'job:MOCK-1',
      variant: 't1',
      dayKey: '2026-09-04',
    };
    expect(buildIdemKey(base)).toBe(buildIdemKey(base));
    type Mutation = { actionType?: ActionType; platform?: string; targetRef?: string; variant?: string; dayKey?: string };
    const mutations: Mutation[] = [
      { platform: 'boss' },
      { targetRef: 'job:MOCK-2' },
      { variant: 't2' },
      { dayKey: '2026-09-05' },
      { actionType: 'send_resume' },
    ];
    const original = buildIdemKey(base);
    for (const m of mutations) {
      expect(buildIdemKey({ ...base, ...m })).not.toBe(original);
    }
    // 确定性：500 次相同输入得到相同键
    const keys = new Set<string>();
    for (let i = 0; i < 500; i++) keys.add(buildIdemKey(base));
    expect(keys.size).toBe(1);
  });
});
