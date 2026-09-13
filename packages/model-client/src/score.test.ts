import { describe, expect, it } from 'vitest';
import { scoreSchema, tierOf, DECISION_LABEL, buildScoreSystem, DEFAULT_CANDIDATE } from './score';

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

describe('V0.4 Score：带本轮 Goal context（避免把已接受约束当风险）', () => {
  it('传入 goalContext 时，提示词声明城市/薪资为"用户已接受、不要当风险"', () => {
    const sys = buildScoreSystem(DEFAULT_CANDIDATE, {
      cities: ['杭州', '深圳'],
      salaryMinK: 30,
      hardExclusions: ['外包', '售前', '纯运营'],
      softNegativePreferences: ['售前属性过强'],
      targetTitles: ['AI产品经理'],
      preferredSkills: ['Agent'],
    });
    expect(sys).toContain('本轮搜索目标');
    expect(sys).toContain('不要把这些当作风险');
    expect(sys).toContain('杭州');
    expect(sys).toContain('30K');
    expect(sys).toContain('不要重复上述已被用户接受的约束');
    // soft 只能影响评分/concerns，禁止据此直接排除
    expect(sys).toContain('弱负向偏好');
    expect(sys).toContain('禁止因此直接判定不推荐');
  });

  it('不传 goalContext 时保持原有提示词（向后兼容）', () => {
    const sys = buildScoreSystem(DEFAULT_CANDIDATE);
    expect(sys).not.toContain('本轮搜索目标');
  });
});
