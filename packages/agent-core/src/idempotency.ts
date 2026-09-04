import type { ActionType } from '@job-agent/domain';

/**
 * 幂等键构造 —— DATA_MODEL §6 公式：
 * {action_type}:{platform}:{target_ref}:{variant}:{day_key}
 * variant 语义由调用方提供（问候=template_id；发简历=mode+触发消息ID摘要；等）。
 * DB 层（action_intents.idem_key UNIQUE）是最终兜底。
 */
export function buildIdemKey(input: {
  actionType: ActionType;
  platform: string;
  targetRef: string;
  variant?: string;
  dayKey: string;
}): string {
  const parts = [input.actionType, input.platform, input.targetRef];
  if (input.variant) parts.push(input.variant);
  parts.push(input.dayKey);
  return parts.join(':');
}
