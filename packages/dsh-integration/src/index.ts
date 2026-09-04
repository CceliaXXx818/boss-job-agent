/**
 * 工具清单声明 —— 与 docs/TOOL_SPEC.md §2 完全一致（19 个）。
 * 注册本身需要 HARNESS_BINDING U1–U5 核验 + 安装 @deepseek-ai/dsh（锁版见 PINNED.md），
 * 未满足前 registerJobAgentTools 一律拒绝（fail-closed）。
 */
export const TOOL_NAMES = [
  'get_profile_and_config',
  'get_system_status',
  'list_candidates',
  'get_job_detail',
  'get_approval_queue',
  'query_audit_log',
  'check_login',
  'search_jobs',
  'score_job',
  'list_unread_messages',
  'classify_hr_message',
  'send_greeting',
  'send_resume',
  'send_template_reply',
  'update_application_status',
  'apply_pending_auto_actions',
  'escalate_to_user',
  'request_pause',
  'generate_daily_report',
] as const;
export type JobAgentToolName = (typeof TOOL_NAMES)[number];

/** 外部写/控制工具（暂停时须被宿主拦截的集合，与 TOOL_SPEC §1 副作用等级对应） */
export const WRITE_TOOL_NAMES: readonly JobAgentToolName[] = [
  'send_greeting',
  'send_resume',
  'send_template_reply',
  'apply_pending_auto_actions',
  'request_pause',
  'generate_daily_report',
];

export class HarnessBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessBindingError';
  }
}

/**
 * 注册 19 个工具到 Harness Agent（完整业务面）。
 * 全量注册仍在 HARNESS_BINDING 真机烟测通过前 fail-closed；
 * 官方扩展 API 的最小实证见 ./spike（registerSpikeTool，U1 已核验）。
 */
export function registerJobAgentTools(_ctx: unknown): void {
  throw new HarnessBindingError(
    'dsh-integration 全量注册被拒绝：需先完成 HARNESS_BINDING 真机烟测（工具注册最小 spike 已实证，见 src/spike.ts；待模型凭据/网络后跑 dsh headless 全量），并安装 @deepseek-ai/dsh@0.1.1-rc.2（已装，见 docs/PINNED.md）',
  );
}
export * from './spike';
