/**
 * 领域枚举与常量 —— DATA_MODEL.md §3 的可执行版本（唯一来源）。
 * P0 仅提供枚举/标签/终态等纯数据；状态机迁移边与校验函数在 P1 的 agent-core 落地。
 */

/** 平台 ID（ARCHITECTURE §5；P0–P2 只允许启用 mock） */
export const PLATFORMS = ['mock', 'boss'] as const;
export type PlatformId = (typeof PLATFORMS)[number];

/** 岗位管道状态（DATA_MODEL §3.2） */
export const APPLICATION_STATES = [
  'DISCOVERED',
  'QUEUED',
  'FILTERED',
  'GREETED',
  'RESUME_SENT',
  'NO_REPLY',
  'INTERVIEWING',
  'NEEDS_HUMAN',
  'FAILED',
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

/** 中文标签（日报/日志展示用） */
export const APPLICATION_STATE_LABELS: Readonly<Record<ApplicationState, string>> = {
  DISCOVERED: '已发现',
  QUEUED: '待沟通',
  FILTERED: '已过滤',
  GREETED: '已打招呼',
  RESUME_SENT: '已发简历',
  NO_REPLY: '暂无回复',
  INTERVIEWING: '面试沟通',
  NEEDS_HUMAN: '待人工处理',
  FAILED: '执行失败',
};

/** 终态：进入后不再自动推进（FAILED 仅用户可复位） */
export const TERMINAL_APPLICATION_STATES: ReadonlySet<ApplicationState> = new Set(['FILTERED', 'FAILED']);

/** HR 意图（DATA_MODEL §3.3；TOOL_SPEC §5 矩阵） */
export const HR_INTENTS = [
  'request_resume',
  'request_online_submit',
  'availability_check',
  'start_date_question',
  'location_confirm',
  'greeting_smalltalk',
  'salary_discussion',
  'reason_for_leaving',
  'interview_invitation',
  'relocation_request',
  'sensitive_data_request',
  'offer_background_check',
  'unknown',
] as const;
export type HrIntent = (typeof HR_INTENTS)[number];

/** 策略桶（HR 消息 → 动作路由） */
export const POLICY_BUCKETS = ['auto_send_resume', 'auto_reply_preset', 'needs_human', 'no_action'] as const;
export type PolicyBucket = (typeof POLICY_BUCKETS)[number];

/** 默认白名单：命中即自动发送简历 */
export const DEFAULT_AUTO_SEND_INTENTS: readonly HrIntent[] = ['request_resume', 'request_online_submit'];

/** 默认升级人工清单（DATA_MODEL §3.3 needs_human 行） */
export const DEFAULT_NEEDS_HUMAN_INTENTS: readonly HrIntent[] = [
  'salary_discussion',
  'reason_for_leaving',
  'interview_invitation',
  'relocation_request',
  'sensitive_data_request',
  'offer_background_check',
  'unknown',
];

/** 动作类型（DATA_MODEL §3.4 action_intents / audit 共用） */
export const ACTION_TYPES = [
  'send_greeting',
  'send_resume',
  'send_template_reply',
  'update_application_status',
  'request_pause',
  'resolve_human_item',
  'generate_daily_report',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** 触发方（DATA_MODEL §3.5） */
export const ACTORS = ['agent', 'user', 'system', 'cron'] as const;
export type Actor = (typeof ACTORS)[number];

/** 意图登记状态（DATA_MODEL §4.5） */
export const INTENT_STATES = ['pending', 'executed', 'failed', 'skipped', 'duplicate', 'cancelled'] as const;
export type IntentState = (typeof INTENT_STATES)[number];

/** 会话线程状态（DATA_MODEL §4.3） */
export const CONVERSATION_STATES = ['active', 'frozen_needs_human', 'closed'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** 消息方向（DATA_MODEL §4.4） */
export const MESSAGE_DIRECTIONS = ['hr', 'agent'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** 评分分桶（ARCHITECTURE §6.4；阈值为程序配置非此处） */
export const SCORE_BUCKETS = ['hot', 'apply', 'review', 'reject', 'filtered'] as const;
export type ScoreBucket = (typeof SCORE_BUCKETS)[number];

/** 分类方法（DATA_MODEL §3.3） */
export const CLASSIFICATION_METHODS = ['rule', 'model', 'manual'] as const;
export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number];
