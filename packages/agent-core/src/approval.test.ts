import { describe, expect, it } from 'vitest';
import { canGreet, DEFAULT_EXCLUDE_TOKENS, mergeExcludeTokens } from '../../../extension/core-logic.js';

/**
 * V0.4 Human Approval / 安全闸门（对应验收测试 8~10）
 * 三条硬规则：没有用户批准不执行；每日 cap 生效；历史 jobId 不重复。
 */
describe('V0.4 打招呼闸门（canGreet）', () => {
  const base = { approved: true, dailyDone: 0, dailyCap: 5, jobId: 'J1', history: [] as string[] };

  it('没有用户批准 → 拒绝执行', () => {
    const r = canGreet({ ...base, approved: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('未获得用户批准');
  });

  it('达到每日上限 → 拒绝执行', () => {
    expect(canGreet({ ...base, dailyDone: 5 }).ok).toBe(false);
    expect(canGreet({ ...base, dailyDone: 4 }).ok).toBe(true);
  });

  it('历史已联系过 → 拒绝执行（跨天去重）', () => {
    const r = canGreet({ ...base, history: ['J1'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('历史');
    expect(canGreet({ ...base, history: ['J2'] }).ok).toBe(true);
  });
});

describe('V0.4 Hard Filter 排除词合并（画像 + Goal，去重）', () => {
  it('合并候选人与用户 Goal 的排除词，并加入内置兜底词', () => {
    const merged = mergeExcludeTokens(['外包'], ['售前', '纯运营']);
    expect(merged).toContain('外包');
    expect(merged).toContain('售前');
    expect(merged).toContain('纯运营');
    for (const t of DEFAULT_EXCLUDE_TOKENS) expect(merged).toContain(t.toLowerCase());
    expect(new Set(merged).size).toBe(merged.length); // 去重
  });
});
