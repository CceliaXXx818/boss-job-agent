import { z } from 'zod';
import { DIM_KEYS } from '@job-agent/job-matcher';
import type { ExtractedEvidence } from '@job-agent/job-matcher';
import type { ModelClient } from './client';

/** 证据提取：DeepSeek 读 JD + 画像 → 每维 0–100 + 证据 + 风险（A3：模型出证据，程序算分）。 */

export const dimScoresSchema = z.object({
  direction: z.number().int().min(0).max(100),
  ai_core: z.number().int().min(0).max(100),
  project: z.number().int().min(0).max(100),
  pm: z.number().int().min(0).max(100),
  industry: z.number().int().min(0).max(100),
  city_mode: z.number().int().min(0).max(100),
});

export const evidenceSchema = z.object({
  dimScores: dimScoresSchema,
  matchedEvidence: z
    .array(
      z.object({
        requirement: z.string(),
        resume_evidence: z.string(),
        status: z.enum(['matched', 'partial', 'missing']),
      }),
    )
    .default([]),
  risks: z.array(z.string()).default([]),
});

const DIM_ZH: Record<(typeof DIM_KEYS)[number], string> = {
  direction: '岗位方向',
  ai_core: 'AI核心能力(LLM/Agent/RAG/提示词/对话AI等)',
  project: '相关项目经验(可举证的0-1落地)',
  pm: '产品经理通用能力',
  industry: '行业经验(金融/客服等)',
  city_mode: '城市与工作方式(是否接受深圳/杭州及通勤)',
};

export interface EvidencePromptInput {
  job: { title: string; city: string; jobType?: string; description: string; tags: string[] };
  candidate: {
    experienceYears: number;
    aiProductYears: number;
    evidenceProjects: string[];
    preferredSkills: string[];
  };
}

export function buildEvidenceSystem(): string {
  const dimLines = DIM_KEYS.map((k) => `- ${k}: ${DIM_ZH[k]}（0–100 整数）`).join('\n');
  return (
    '你是资深 AI 招聘匹配分析师。请严格依据【JD】与【候选人画像】判断匹配度。' +
    '证据规则：resume_evidence 只能来自画像内容，禁止编造简历中不存在的能力或指标；无证据的维度给低分。' +
    `六个维度：\n${dimLines}\n` +
    '输出 JSON 结构：{"dimScores":{六个维度0-100},"matchedEvidence":[{"requirement":"JD要求原文","resume_evidence":"画像中的对应证据","status":"matched|partial|missing"}],"risks":["风险项"]}'
  );
}

export function buildEvidenceUser(input: EvidencePromptInput): string {
  return [
    '【JD】',
    `岗位：${input.job.title}（${input.job.city}）`,
    input.job.jobType ? `类型：${input.job.jobType}` : '',
    `标签：${input.job.tags.join('、') || '无'}`,
    `正文：${input.job.description}`,
    '',
    '【候选人画像】',
    `总产品经验 ${input.candidate.experienceYears} 年，其中 AI 方向 ${input.candidate.aiProductYears} 年`,
    `证据项目：${input.candidate.evidenceProjects.join('、') || '无'}`,
    `偏好技能：${input.candidate.preferredSkills.join('、') || '无'}`,
    '',
    '请输出唯一 JSON。',
  ].join('\n');
}

/** 用真实模型提取证据。VCR 由调用方（测试/服务）负责。 */
export async function extractEvidenceWithModel(client: ModelClient, input: EvidencePromptInput): Promise<ExtractedEvidence> {
  const data = await client.chatJson(evidenceSchema, buildEvidenceSystem(), buildEvidenceUser(input));
  return data as ExtractedEvidence;
}
