import { describe, expect, it } from 'vitest';
import { hardFilter } from './hard-filter';
import type { HardFilterConfig, JobFacts } from './hard-filter';
import { bucketOf, computeScore, DEFAULT_RUBRIC, finalizeEvidence } from './rubric';

const CFG: HardFilterConfig = {
  targetCities: ['深圳', '杭州'],
  excludeCities: ['北京', '上海'],
  excludeJobTypes: ['纯数据标注', '纯AI运营', '模型训练运营', '纯项目经理', '销售岗位'],
  excludeWorkModes: ['长期海外驻场', '驻外'],
  targetJobTitles: ['AI产品经理', '大模型产品经理', 'Agent产品经理', '对话AI产品经理', '智能客服产品经理', 'AI解决方案产品经理', '高级产品经理-AI方向'],
};

function job(over: Partial<JobFacts>): JobFacts {
  return { title: 'AI产品经理', city: '深圳', tags: [], description: 'LLM 客服产品', ...over };
}

describe('job-matcher: 硬过滤（确定性）', () => {
  it('排除城市北京/上海直接拒绝', () => {
    expect(hardFilter(CFG, job({ city: '北京' }))).toEqual({ passed: false, reason: 'exclude_city' });
    expect(hardFilter(CFG, job({ city: '上海' }))).toEqual({ passed: false, reason: 'exclude_city' });
  });
  it('非目标城市拒绝', () => {
    expect(hardFilter(CFG, job({ city: '广州' }))).toEqual({ passed: false, reason: 'target_city_mismatch' });
  });
  it('排除岗位类型（销售/数据标注/驻外）拒绝', () => {
    expect(hardFilter(CFG, job({ jobType: '销售岗位' }))).toEqual({ passed: false, reason: 'exclude_job_type' });
    expect(hardFilter(CFG, job({ title: '数据标注员', description: '纯数据标注' }))).toEqual({
      passed: false,
      reason: 'exclude_job_type',
    });
    expect(hardFilter(CFG, job({ workMode: '长期海外驻场' }))).toEqual({ passed: false, reason: 'exclude_work_mode' });
    expect(hardFilter(CFG, job({ description: '需要长期驻外出差' }))).toEqual({
      passed: false,
      reason: 'exclude_work_mode',
    });
  });
  it('深圳 AI 产品经理通过', () => {
    expect(hardFilter(CFG, job({ city: '深圳' }))).toEqual({ passed: true });
  });
});

describe('job-matcher: 加权评分与分桶（程序算分）', () => {
  it('PRD 权重表求和为 100', () => {
    const total = Object.values(DEFAULT_RUBRIC.weights).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('computeScore 按权重加权', () => {
    // 全满分 → 100
    const all = { direction: 100, ai_core: 100, project: 100, pm: 100, industry: 100, city_mode: 100 };
    expect(computeScore(all, DEFAULT_RUBRIC.weights)).toBe(100);
    // 仅 direction 满分 → 20
    const onlyDir = { direction: 100, ai_core: 0, project: 0, pm: 0, industry: 0, city_mode: 0 };
    expect(computeScore(onlyDir, DEFAULT_RUBRIC.weights)).toBe(20);
  });

  it('分桶阈值：86→hot、77→apply、70→review、50→reject', () => {
    const t = { hot: 80, apply: 75, review: 65 };
    expect(bucketOf(86, t)).toBe('hot');
    expect(bucketOf(77, t)).toBe('apply');
    expect(bucketOf(70, t)).toBe('review');
    expect(bucketOf(50, t)).toBe('reject');
  });

  it('finalizeEvidence 输出可复算的 ScoreOutcome', () => {
    const out = finalizeEvidence(
      {
        dimScores: { direction: 100, ai_core: 90, project: 80, pm: 60, industry: 40, city_mode: 100 },
        matchedEvidence: [
          { requirement: '具备LLM+RAG落地经验', resume_evidence: '主导LLM+RAG客服上线', status: 'matched' },
        ],
        risks: ['JD 要求完整 Agent 平台经验'],
      },
      DEFAULT_RUBRIC,
      { hot: 80, apply: 75, review: 65 },
    );
    expect(out.scoreTotal).toBe(Math.round((100 * 20 + 90 * 25 + 80 * 25 + 60 * 15 + 40 * 5 + 100 * 10) / 100));
    expect(out.rubricVersion).toBe('2026.09.0');
    expect(out.matchedEvidence[0]?.status).toBe('matched');
  });
});
