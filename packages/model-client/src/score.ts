import { z } from 'zod';
import type { ModelClient } from './client';

/**
 * A1 岗位决策评分（模型给证据与理由，程序定档与闸门）。
 * 输入=详情已抓字段（JD/真实薪资/经验学历/公司规模），不要求模型看网页。
 */

export interface JobScoreInput {
  title: string;
  company?: string;
  area?: string;
  salaryAscii?: string; // 如 "30-50K"
  expEdu: string[];
  companyMeta: string[];
  descFull: string;
}

export interface CandidateProfileText {
  experienceYears: number;
  aiProductYears: number;
  evidenceProjects: string[];
  preferredSkills: string[];
  targetTitles: string[];
  excludeTokens: string[];
}

export const DEFAULT_CANDIDATE: CandidateProfileText = {
  experienceYears: 7,
  aiProductYears: 3,
  evidenceProjects: ['AI智能语音外呼', 'LLM与RAG智能客服', '智能质检平台', '智能对话数字人'],
  preferredSkills: ['LLM', 'Agent', 'RAG', 'Prompt Engineering', 'Conversational AI', '智能客服', '智能外呼', '智能质检', 'Workflow', 'Function Calling'],
  targetTitles: ['AI产品经理', '大模型产品经理', 'Agent产品经理', '对话AI产品经理', '智能客服产品经理', 'AI解决方案产品经理', '高级产品经理-AI方向'],
  excludeTokens: ['数据标注', 'AI运营', '训练运营', '销售', '驻外', '外派', '纯运营', '标注'],
};

export const scoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  strengths: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  matchedNote: z.string().default(''),
});

export type ModelScore = z.infer<typeof scoreSchema>;

/** 程序定档：hot≥80 / apply≥75 / review≥65 / reject<65 */
export function tierOf(score: number): 'hot' | 'apply' | 'review' | 'reject' {
  if (score >= 80) return 'hot';
  if (score >= 75) return 'apply';
  if (score >= 65) return 'review';
  return 'reject';
}

export const DECISION_LABEL: Record<ReturnType<typeof tierOf>, string> = {
  hot: '优先打招呼',
  apply: '可打招呼',
  review: '人工确认',
  reject: '建议放弃',
};

export function profilePrompt(c: CandidateProfileText): string {
  return [
    `总产品经验 ${c.experienceYears} 年，其中 AI 方向 ${c.aiProductYears} 年`,
    `证据项目：${c.evidenceProjects.join('、')}`,
    `偏好技能：${c.preferredSkills.join('、')}`,
    `目标岗位关键词：${c.targetTitles.join('、')}`,
    `明确排除：${c.excludeTokens.join('、')}`,
  ].join('\n');
}

export function buildScoreSystem(c: CandidateProfileText): string {
  return (
    '你是资深招聘匹配评审。基于候选人与【岗位资料】打分（0-100 整数）。评分规则：' +
    '方向/技能匹配与 JD 证据(Agent/大模型/LLM/RAG/客服/外呼/质检等)占权重最高；' +
    '薪资低于候选人期望、经验要求远超或太低、地点不符、外包/标注/纯销售/纯运营要扣重分。' +
    '只依据给出资料与候选人画像，不得编造画像外能力。' +
    '输出 JSON：{"score":0-100整数,"strengths":["与JD匹配的优势，须源自画像或JD"],"concerns":["风险/不匹配点"],"matchedNote":"一段话结论(≤60字)"}\n' +
    `【候选人画像】\n${profilePrompt(c)}`
  );
}

export function buildScoreUser(j: JobScoreInput): string {
  return [
    '【岗位资料】',
    `岗位：${j.title}`,
    j.company ? `公司：${j.company}` : '',
    j.area ? `地点：${j.area}` : '',
    j.salaryAscii ? `薪资：${j.salaryAscii}` : '',
    j.expEdu.length ? `经验/学历：${j.expEdu.join(' / ')}` : '',
    j.companyMeta.length ? `公司信息：${j.companyMeta.join(' / ')}` : '',
    `JD：${j.descFull.slice(0, 4000)}`,
    '',
    '请输出唯一 JSON。',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function scoreJobWithModel(
  client: ModelClient,
  job: JobScoreInput,
  candidate: CandidateProfileText = DEFAULT_CANDIDATE,
): Promise<ModelScore> {
  const data = await client.chatJson(scoreSchema, buildScoreSystem(candidate), buildScoreUser(job));
  return data as ModelScore;
}
