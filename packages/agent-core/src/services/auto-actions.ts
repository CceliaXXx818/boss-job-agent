import type { HrIntent, PolicyBucket } from '@job-agent/domain';
import type { AgentRepo } from '../store/repo';
import type { ActionGate, PerformResult } from './action-gate';
import type { ConversationMessage, JobPlatformAdapter } from '../ports/job-platform';

/**
 * 消息策略执行器 —— P2-④：确定性执行 HR 消息对应的策略动作（TOOL_SPEC §5）。
 * 与 TOOL_SPEC #16 apply_pending_auto_actions 同语义：模型可以不调、系统扫描兜底，
 * 三重门保证"不重复、不漏发、不乱发"。classify/policy/preset 通过注入解耦（规则版或模型版）。
 */

export interface PolicyHooks {
  classify(text: string): { intent: HrIntent };
  policyFor(intent: HrIntent): PolicyBucket;
  presetFor(intent: HrIntent): { key: string; text: string } | undefined;
}

export interface ExecResult {
  intent: HrIntent;
  bucket: PolicyBucket;
  action: 'send_resume' | 'send_template_reply' | 'escalate' | 'none';
  outcome: 'executed' | 'duplicate' | 'skipped' | 'already_state';
  detail?: string;
}

/** ActionGate 结果 → ExecResult.outcome 映射 */
function mapGateOutcome(kind: string): ExecResult['outcome'] {
  if (kind === 'executed') return 'executed';
  if (kind === 'duplicate') return 'duplicate';
  return 'skipped';
}

export class AutoActionExecutor {  constructor(
    private readonly repo: AgentRepo,
    private readonly adapter: JobPlatformAdapter,
    private readonly gate: ActionGate,
    private readonly hooks: PolicyHooks,
    private readonly nowIso: () => string,
  ) {}

  /** 处理一条 HR 消息：判定→执行/升级。调用方保证消息尚未处理过（水位线去重在其上层）。 */
  async applyForMessage(input: {
    jobId: string;
    applicationId: string;
    conversationId: string;
    message: ConversationMessage;
    dayKey: string;
    runId: string;
    maxResumeQuota?: number;
  }): Promise<ExecResult> {
    const { jobId, applicationId, conversationId, message, dayKey, runId } = input;
    const at = this.nowIso();
    const { intent } = this.hooks.classify(message.text);
    const bucket = this.hooks.policyFor(intent);
    const appState = this.repo.applicationState(applicationId);

    if (bucket === 'auto_send_resume') {
      if (appState === 'RESUME_SENT') return { intent, bucket, action: 'send_resume', outcome: 'already_state' };
      if (appState !== 'GREETED' && appState !== 'QUEUED') {
        return { intent, bucket, action: 'send_resume', outcome: 'skipped', detail: `state=${appState}` };
      }
      const out = await this.gate.execute(
        {
          actionType: 'send_resume',
          platform: this.adapter.platformId,
          targetRef: `conv:${conversationId}`,
          variant: `online:${message.messageId.slice(-12)}`,
          payloadJson: JSON.stringify({ mode: 'online', source: message.text }),
          dayKey,
          runId,
          actor: 'system',
          entityType: 'application',
          entityId: applicationId,
          quota: { max: input.maxResumeQuota ?? Number.MAX_SAFE_INTEGER, takesQuota: false },
        },
        () => this.adapter.sendResume(conversationId, { mode: 'online' }) as Promise<PerformResult>,
      );
      if (out.kind === 'executed') {
        if (appState === 'GREETED') {
          this.repo.transitionApplication(applicationId, 'RESUME_SENT', at, {
            resume_sent_at: at,
            resume_mode: 'online',
          });
        }
        return { intent, bucket, action: 'send_resume', outcome: 'executed', detail: out.effectId };
      }
      return { intent, bucket, action: 'send_resume', outcome: mapGateOutcome(out.kind), detail: JSON.stringify(out) };
    }

    if (bucket === 'auto_reply_preset') {
      const preset = this.hooks.presetFor(intent);
      if (!preset) return { intent, bucket, action: 'none', outcome: 'skipped', detail: 'no preset' };
      const out = await this.gate.execute(
        {
          actionType: 'send_template_reply',
          platform: this.adapter.platformId,
          targetRef: `conv:${conversationId}`,
          variant: preset.key,
          payloadJson: JSON.stringify({ text: preset.text }),
          dayKey,
          runId,
          actor: 'system',
          entityType: 'application',
          entityId: applicationId,
        },
        () => this.adapter.sendTextReply(conversationId, preset.text) as Promise<PerformResult>,
      );
      return { intent, bucket, action: 'send_template_reply', outcome: mapGateOutcome(out.kind), detail: JSON.stringify(out) };
    }

    // needs_human：冻结会话，绝不自动外发
    if (appState === 'GREETED' || appState === 'RESUME_SENT' || appState === 'NO_REPLY') {
      this.repo.transitionApplication(applicationId, 'NEEDS_HUMAN', at, {
        needs_human_reason: intent,
        next_action: '等待用户处理',
      });
      // 会话行可能尚未在 DB 中登记（如纯流程测试），先确保存在再冻结
      this.repo.store.db
        .prepare(
          `INSERT OR IGNORE INTO conversations (conversation_id, platform, job_external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(conversationId, this.adapter.platformId, jobId, at, at);
      this.repo.store.db
        .prepare(`UPDATE conversations SET state = 'frozen_needs_human', frozen_reason = ?, frozen_at = ? WHERE conversation_id = ?`)
        .run(intent, at, conversationId);
    }
    return { intent, bucket, action: 'escalate', outcome: 'executed' };
  }
}
