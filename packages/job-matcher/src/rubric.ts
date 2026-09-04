/**
 * 评分权重表 —— PRD 第四节（ARCHITECTURE §6.4）。
 * 程序算分，模型只出证据（A3）。rubric_version 随表变化递增。
 */

export const DIM_KEYS = ['direction', 'ai_core', 'project', 'pm', 'industry', 'city_mode'] as const;
export type DimKey = (typeof DIM_KEYS)[number];

export interface Rubric {
  version: string;
  weights: Record<DimKey, number>;
}

export const DEFAULT_RUBRIC: Rubric = {
  version: '2026.09.0',
  weights: { direction: 20, ai_core: 25, project: 25, pm: 15, industry: 5, city_mode: 10 },
};

export interface EvidenceItem {
  requirement: string;
  resume_evidence: string;
  status: 'matched' | 'partial' | 'missing';
}

/** 证据提取结果：每维 0–100 分 + 证据 + 风险。模型/规则实现须遵守此契约。 */
export interface ExtractedEvidence {
  dimScores: Record<DimKey, number>;
  matchedEvidence: EvidenceItem[];
  risks: string[];
}

export interface ScoreOutcome {
  scoreTotal: number;
  scoreDims: Record<DimKey, number>;
  bucket: 'hot' | 'apply' | 'review' | 'reject';
  matchedEvidence: EvidenceItem[];
  risks: string[];
  rubricVersion: string;
}

export interface BucketThresholds {
  hot: number;
  apply: number;
  review: number;
}

/** 按权重表计算加权总分（四舍五入到整数） */
export function computeScore(dims: Record<DimKey, number>, weights: Record<DimKey, number>): number {
  let sum = 0;
  for (const k of DIM_KEYS) sum += dims[k] * weights[k];
  return Math.round(sum / 100);
}

export function bucketOf(total: number, t: BucketThresholds): ScoreOutcome['bucket'] {
  if (total >= t.hot) return 'hot';
  if (total >= t.apply) return 'apply';
  if (total >= t.review) return 'review';
  return 'reject';
}

export function finalizeEvidence(
  evidence: ExtractedEvidence,
  rubric: Rubric,
  thresholds: BucketThresholds,
): ScoreOutcome {
  const scoreTotal = computeScore(evidence.dimScores, rubric.weights);
  return {
    scoreTotal,
    scoreDims: evidence.dimScores,
    bucket: bucketOf(scoreTotal, thresholds),
    matchedEvidence: evidence.matchedEvidence,
    risks: evidence.risks,
    rubricVersion: rubric.version,
  };
}
