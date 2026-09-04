import { z } from 'zod';
import { HR_INTENTS } from '@job-agent/domain';
import type { HrIntent } from '@job-agent/domain';
import { classifyByRule, policyBucketFor } from '@job-agent/conversation-policy';
import type { PolicyBucket } from '@job-agent/domain';
import type { ModelClient } from './client';

/** HR 疑难消息：模型在规则未命中时兜底判定（必须从枚举选，禁自造）。 */

const INTENT_ZH: Record<HrIntent, string> = {
  request_resume: '索要简历/附件',
  request_online_submit: '要求投递在线简历',
  availability_check: '询问在职状态',
  start_date_question: '询问到岗/入职时间',
  location_confirm: '确认工作城市',
  greeting_smalltalk: '纯寒暄问候',
  salary_discussion: '询问薪资(需人工)',
  reason_for_leaving: '询问离职原因(需人工)',
  interview_invitation: '邀约面试(需人工)',
  relocation_request: '要求异地/驻外(需人工)',
  sensitive_data_request: '索要敏感资料如身份证/卡号(需人工)',
  offer_background_check: 'Offer/背调/合同话题(需人工)',
  unknown: '无法判定(需人工)',
};

export const hrIntentChoiceSchema = z.object({
  intent: z.enum([...HR_INTENTS] as [string, ...string[]]),
  confidence: z.number().int().min(0).max(100),
  reason: z.string(),
});

export interface HrIntentChoice {
  intent: HrIntent;
  confidence: number;
  reason: string;
}

export function buildIntentSystem(): string {
  const lines = HR_INTENTS.map((i) => `- ${i}: ${INTENT_ZH[i]}`).join('\n');
  return (
    `你是招聘对话意图识别器。从下列唯一枚举中选择最匹配的一类（id 形式），禁止自造类别：\n${lines}\n` +
    '判定注意：greeting_smalltalk 仅限纯粹寒暄（如"你好/在吗"）；若开场伴随实质问题或征询（如"介绍一下你自己""你们团队多少人""这个业务线怎么样""还有什么想问的"），不得归为 greeting_smalltalk；' +
    '含薪资/面试/背调/驻外等敏感话题的即使以寒暄开头也按对应类别；无法归类的必须用 unknown。\n' +
    '输出 JSON：{"intent":"枚举id","confidence":0-100整数,"reason":"一句话判定理由"}'
  );
}

/** 模型判定单条 HR 消息意图（用于规则未命中的疑难消息）。 */
export async function classifyHrIntentWithModel(client: ModelClient, text: string): Promise<HrIntentChoice> {
  const data = await client.chatJson(
    hrIntentChoiceSchema,
    buildIntentSystem(),
    `HR 消息原文：\n${text}\n请输出唯一 JSON。`,
  );
  return {
    intent: data.intent as HrIntent,
    confidence: data.confidence,
    reason: data.reason,
  };
}

/**
 * 单条消息的"规则优先 → 模型兜底"混合判定（同步函数无法承载 async 模型，
 * 故这里返回可 await 的一次性函数结果；AutoActionExecutor 的模型兜底接入放 profile 集成阶段）。
 */
export async function hybridClassifyOnce(
  client: ModelClient,
  text: string,
): Promise<{ intent: HrIntent; method: 'rule' | 'model'; confidence: number }> {
  const rule = classifyByRule(text);
  if (rule.intent !== 'unknown') {
    return { intent: rule.intent, method: 'rule', confidence: 1 };
  }
  const model = await classifyHrIntentWithModel(client, text);
  return { intent: model.intent, method: 'model', confidence: model.confidence / 100 };
}

/** 意图 → 策略桶（复用 conversation-policy 默认白名单；TOOL_SPEC §5） */
export function bucketForIntent(intent: HrIntent): PolicyBucket {
  return policyBucketFor(intent);
}
