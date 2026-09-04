import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@job-agent/sqlite-store';
import { ActionGate } from './action-gate';
import { AgentRepo } from '../store/repo';

const DAY = '2026-09-04';
const AT = '2026-09-04T02:00:00.000Z';

function fresh(): { gate: ActionGate; repo: AgentRepo; close: () => void } {
  const store = SqliteStore.open(':memory:');
  store.migrate();
  const repo = new AgentRepo(store);
  const gate = new ActionGate(repo, { maxAttempts: 1 });
  return { gate, repo, close: () => store.close() };
}

function base(over: Partial<Parameters<ActionGate['execute']>[0]> = {}) {
  return {
    actionType: 'send_greeting' as const,
    platform: 'mock' as const,
    targetRef: 'job:MOCK-1',
    variant: 't1',
    payloadJson: JSON.stringify({ text: '您好…' }),
    dayKey: DAY,
    runId: `run_${DAY}`,
    actor: 'agent' as const,
    quota: { max: 30, takesQuota: true },
    ...over,
  };
}

describe('ActionGate：三重门（ARCHITECTURE §4.4）', () => {
  it('首次执行成功：perform 恰好调用一次，intent 置 executed 并带 effectId', async () => {
    const { gate, repo, close } = fresh();
    try {
      let calls = 0;
      const out = await gate.execute(base(), async () => {
        calls++;
        return { ok: true, effectId: 'eff-1' };
      });
      expect(out.kind).toBe('executed');
      expect(calls).toBe(1);
      const rec = repo.findIntentByIdemKey('send_greeting:mock:job:MOCK-1:t1:2026-09-04');
      expect(rec?.state).toBe('executed');
      // 配额已占 1
      expect(repo.usedQuota('mock', 'send_greeting', DAY)).toBe(1);
    } finally {
      close();
    }
  });

  it('同幂等键再次调用 → duplicate，perform 不再被调用（零重复副作用）', async () => {
    const { gate, repo, close } = fresh();
    try {
      let calls = 0;
      const perform = async () => {
        calls++;
        return { ok: true, effectId: 'eff-1' };
      };
      const first = await gate.execute(base(), perform);
      const second = await gate.execute(base(), perform);
      expect(first.kind).toBe('executed');
      expect(second.kind).toBe('duplicate');
      expect(calls).toBe(1);
      expect(repo.usedQuota('mock', 'send_greeting', DAY)).toBe(1);
    } finally {
      close();
    }
  });

  it('配额已满 → quota_exhausted，不创建 intent 不调用 perform', async () => {
    const { gate, repo, close } = fresh();
    try {
      // 先用小配额占满一个
      const out = await gate.execute(base({ targetRef: 'job:A', quota: { max: 1, takesQuota: true } }), async () => ({
        ok: true,
        effectId: 'eff-a',
      }));
      expect(out.kind).toBe('executed');
      // 第二个不同目标但 max=1
      const second = await gate.execute(base({ targetRef: 'job:B', quota: { max: 1, takesQuota: true } }), async () => ({
        ok: true,
      }));
      expect(second.kind).toBe('quota_exhausted');
      expect(repo.findIntentByIdemKey('send_greeting:mock:job:B:t1:2026-09-04')).toBeUndefined();
    } finally {
      close();
    }
  });

  it('全局暂停 → paused，perform 不被调用', async () => {
    const { gate, repo, close } = fresh();
    try {
      repo.setSetting('global_pause', { active: true, reason: 'verification' }, AT);
      let calls = 0;
      const out = await gate.execute(base(), async () => {
        calls++;
        return { ok: true };
      });
      expect(out.kind).toBe('paused');
      expect(calls).toBe(0);
    } finally {
      close();
    }
  });

  it('政策拒绝（如 needs_human）→ policy_denied', async () => {
    const { gate, close } = fresh();
    try {
      const out = await gate.execute(base({ policyAllowed: { allowed: false, reason: 'frozen_needs_human' } }), async () => ({
        ok: true,
      }));
      expect(out.kind).toBe('policy_denied');
    } finally {
      close();
    }
  });

  it('失败可重试 1 次（maxAttempts=1），第 2 次成功；超限后拒绝', async () => {
    const { gate, close } = fresh();
    try {
      let calls = 0;
      const flaky = async () => {
        calls++;
        if (calls === 1) return { ok: false, error: { message: '网络抖动', retryable: true } };
        return { ok: true, effectId: 'eff-ok' };
      };
      const first = await gate.execute(base(), flaky);
      expect(first.kind).toBe('failed');
      const second = await gate.execute(base(), flaky);
      expect(second.kind).toBe('executed');
      expect(calls).toBe(2);

      // 再失败两次：第三次应 attempts_exceeded
      let calls2 = 0;
      const alwaysFail = async () => {
        calls2++;
        return { ok: false, error: { message: 'x', retryable: true } };
      };
      const a1 = await gate.execute(base({ targetRef: 'job:C' }), alwaysFail);
      const a2 = await gate.execute(base({ targetRef: 'job:C' }), alwaysFail);
      const a3 = await gate.execute(base({ targetRef: 'job:C' }), alwaysFail);
      expect(a1.kind).toBe('failed');
      expect(a2.kind).toBe('failed');
      expect(a3.kind).toBe('failed');
      expect((a3 as { reason: string }).reason).toBe('attempts_exceeded');
    } finally {
      close();
    }
  });
});
