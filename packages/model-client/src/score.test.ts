import { describe, expect, it } from 'vitest';
import { scoreSchema, tierOf, DECISION_LABEL } from './score';

describe('A1 岗位决策评分：schema 与定档', () => {
  it('schema 字段齐备（score 0-100 + 证据性理由）', () => {
    const ok = scoreSchema.safeParse({ score: 86, strengths: ['LLM+RAG落地'], concerns: ['行业经验少'], matchedNote: '匹配度高' });
    expect(ok.success).toBe(true);
    const bad = scoreSchema.safeParse({ score: 200 });
    expect(bad.success).toBe(false);
  });

  it('程序定档与标签（hot≥80/apply≥75/review≥65/reject<65）', () => {
    expect(tierOf(88)).toBe('hot');
    expect(tierOf(77)).toBe('apply');
    expect(tierOf(70)).toBe('review');
    expect(tierOf(50)).toBe('reject');
    expect(DECISION_LABEL.reject).toBe('建议放弃');
  });
});
