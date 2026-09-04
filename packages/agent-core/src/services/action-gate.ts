import type { ActionType, Actor, PlatformId } from '@job-agent/domain';
import { buildIdemKey } from '../idempotency';
import type { AgentRepo } from '../store/repo';

/**
 * 写操作三重门引擎 —— ARCHITECTURE §4.4 / DATA_MODEL §4.5。
 * 顺序：① 政策/暂停 → ② 幂等（已执行=duplicate；失败且未超限=重试）+ 限额 → ③ 登记 intent → 执行 → 审计。
 * 任何路径都不可能产生第二次平台副作用（DB idem_key UNIQUE 兜底）。
 */

export interface PerformResult {
  ok: boolean;
  effectId?: string;
  error?: { message: string; retryable: boolean };
}

export type GateOutcome =
  | { kind: 'executed'; intentId: string; effectId?: string }
  | { kind: 'duplicate'; originalIntentId: string }
  | { kind: 'quota_exhausted'; used: number; max: number }
  | { kind: 'paused' }
  | { kind: 'policy_denied'; reason: string }
  | { kind: 'failed'; intentId: string; reason: string; retryable: boolean };

export interface GateExecParams {
  actionType: ActionType;
  platform: PlatformId;
  targetRef: string;
  variant?: string;
  payloadJson: string;
  dayKey: string;
  runId: string;
  actor: Actor;
  entityType?: string;
  entityId?: string;
  /** 今日该动作限额；takesQuota=false 时不占额度 */
  quota?: { max: number; takesQuota: boolean };
  policyAllowed?: { allowed: boolean; reason?: string };
  at?: string;
}

export class ActionGate {
  constructor(
    private readonly repo: AgentRepo,
    private readonly opts: { maxAttempts?: number } = {},
  ) {}

  private get maxAttempts(): number {
    return this.opts.maxAttempts ?? 1;
  }

  async execute(params: GateExecParams, perform: () => Promise<PerformResult>): Promise<GateOutcome> {
    const at = params.at ?? new Date().toISOString();
    const audit = (event: string, result: string, payload: unknown, errorCode?: string, intentId?: string) =>
      this.repo.insertAudit({
        at,
        dayKey: params.dayKey,
        runId: params.runId,
        actor: params.actor,
        category: 'external_write',
        event: `${params.actionType}.${event}`,
        result,
        entityType: params.entityType,
        entityId: params.entityId,
        payloadJson: JSON.stringify(payload),
        errorCode,
        actionIntentId: intentId,
        source: 'action-gate',
      });

    // ① 全局暂停：一律拒绝
    const pause = this.repo.getSetting<{ active: boolean; reason?: string }>('global_pause');
    if (pause?.active) {
      audit('skipped_paused', 'skipped', { reason: pause.reason ?? 'paused' });
      return { kind: 'paused' };
    }
    // ① 业务政策（如 HR 话题 needs_human / 状态不允许）
    if (params.policyAllowed && !params.policyAllowed.allowed) {
      audit('skipped_policy', 'skipped', { reason: params.policyAllowed.reason ?? 'policy_denied' });
      return { kind: 'policy_denied', reason: params.policyAllowed.reason ?? 'policy_denied' };
    }

    const idemKey = buildIdemKey({
      actionType: params.actionType,
      platform: params.platform,
      targetRef: params.targetRef,
      variant: params.variant,
      dayKey: params.dayKey,
    });

    // ② 幂等：已成功执行过 → duplicate（零副作用）
    const existing = this.repo.findIntentByIdemKey(idemKey);
    if (existing?.state === 'executed') {
      audit('duplicate', 'duplicate', { originalIntentId: existing.intent_id });
      return { kind: 'duplicate', originalIntentId: existing.intent_id };
    }
    if (existing?.state === 'failed' && existing.attempts > this.maxAttempts) {
      audit('attempts_exceeded', 'failed', {}, 'ATTEMPTS_EXCEEDED', existing.intent_id);
      return { kind: 'failed', intentId: existing.intent_id, reason: 'attempts_exceeded', retryable: false };
    }

    // ② 限额：占额动作今日已满 → 拒绝（不建 intent）
    if (params.quota?.takesQuota) {
      const used = this.repo.usedQuota(params.platform, params.actionType, params.dayKey);
      if (used >= params.quota.max) {
        audit('skipped_quota', 'skipped', { used, max: params.quota.max });
        return { kind: 'quota_exhausted', used, max: params.quota.max };
      }
    }

    // ③ 登记（新建或复用同 key 的失败记录继续重试）→ 执行 → 结果落库
    const intentId =
      existing?.intent_id ??
      this.repo.insertIntent({
        idemKey,
        actionType: params.actionType,
        runId: params.runId,
        platform: params.platform,
        targetRef: params.targetRef,
        payloadJson: params.payloadJson,
        at,
      });

    let performResult: PerformResult;
    try {
      performResult = await perform();
    } catch (e) {
      performResult = { ok: false, error: { message: (e as Error).message, retryable: false } };
    }
    if (performResult.ok) {
      this.repo.markIntentExecuted(intentId, performResult.effectId, at, params.quota?.takesQuota ?? false);
      audit('executed', 'ok', { effectId: performResult.effectId }, undefined, intentId);
      return { kind: 'executed', intentId, effectId: performResult.effectId };
    }
    const err = performResult.error ?? { message: 'unknown', retryable: false };
    this.repo.markIntentFailed(intentId, err.message, at);
    audit('failed', 'failed', { error: err.message }, 'PLATFORM_ERROR', intentId);
    return { kind: 'failed', intentId, reason: err.message, retryable: err.retryable };
  }
}
