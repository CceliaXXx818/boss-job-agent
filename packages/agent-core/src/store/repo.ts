import { randomUUID } from 'node:crypto';
import type {
  ActionType,
  Actor,
  ApplicationState,
  PlatformId,
} from '@job-agent/domain';
import type { SqliteStore } from '@job-agent/sqlite-store';
import { assertTransition } from '../model/application-state';

/** 时间有序、足够唯一的本地 ID（测试与演示无需全局单调性） */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = randomUUID().replace(/-/g, '').slice(0, 14);
  return prefix ? `${prefix}_${t}${r}` : `id_${t}${r}`;
}

export interface AuditInput {
  at: string;
  dayKey: string;
  actor: Actor;
  category: string;
  event: string;
  result: string;
  runId?: string;
  entityType?: string;
  entityId?: string;
  payloadJson?: string;
  errorCode?: string;
  actionIntentId?: string;
  source?: string;
}

/**
 * 领域仓储 —— 直接映射 DATA_MODEL 表。
 * 职责：候选 upsert / 应用状态机迁移 / 审计 append-only / 意图账本 / 设置。
 */
export class AgentRepo {
  constructor(readonly store: SqliteStore) {}

  // ---------- candidate_jobs ----------

  upsertCandidate(input: {
    externalId: string;
    url: string;
    fingerprint: string;
    title: string;
    company: string;
    city: string;
    salaryText?: string;
    salaryMinK?: number;
    salaryMaxK?: number;
    experienceRequired?: string;
    educationRequired?: string;
    tags?: string[];
    jobType?: string;
    description: string;
    hrName?: string;
    dayKey: string;
    at: string;
    platform?: PlatformId;
  }): { inserted: boolean; id: string; seenCount: number } {
    const platform = input.platform ?? 'mock';
    const existing = this.store.db
      .prepare('SELECT id, seen_count FROM candidate_jobs WHERE platform = ? AND external_id = ?')
      .get(platform, input.externalId) as { id: string; seen_count: number } | undefined;
    if (existing) {
      this.store.db
        .prepare(
          `UPDATE candidate_jobs
             SET latest_seen_day = ?, seen_count = seen_count + 1,
                 is_active = 1, updated_at = ?,
                 url = ?, fingerprint = ?, title = ?, company = ?, city = ?,
                 salary_text = ?, salary_min_k = ?, salary_max_k = ?,
                 experience_required = ?, education_required = ?, tags_json = ?,
                 job_type = ?, description = ?, hr_name = ?
           WHERE id = ?`,
        )
        .run(
          input.dayKey, input.at, input.url, input.fingerprint, input.title, input.company, input.city,
          input.salaryText ?? null, input.salaryMinK ?? null, input.salaryMaxK ?? null,
          input.experienceRequired ?? null, input.educationRequired ?? null,
          input.tags?.length ? JSON.stringify(input.tags) : null, input.jobType ?? null,
          input.description, input.hrName ?? null, existing.id,
        );
      return { inserted: false, id: existing.id, seenCount: existing.seen_count + 1 };
    }
    const id = newId('job');
    this.store.db
      .prepare(
        `INSERT INTO candidate_jobs
           (id, platform, external_id, url, fingerprint, title, company, city, salary_text,
            salary_min_k, salary_max_k, experience_required, education_required, tags_json, job_type,
            description, hr_name, first_seen_day, latest_seen_day, discovered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, platform, input.externalId, input.url, input.fingerprint, input.title, input.company, input.city,
        input.salaryText ?? null, input.salaryMinK ?? null, input.salaryMaxK ?? null,
        input.experienceRequired ?? null, input.educationRequired ?? null,
        input.tags?.length ? JSON.stringify(input.tags) : null, input.jobType ?? null,
        input.description, input.hrName ?? null, input.dayKey, input.dayKey, input.at, input.at,
      );
    return { inserted: true, id, seenCount: 1 };
  }

  // ---------- applications ----------

  findApplication(platform: PlatformId, externalJobId: string): { application_id: string; state: string } | undefined {
    return this.store.db
      .prepare('SELECT application_id, state FROM applications WHERE platform = ? AND job_external_id = ?')
      .get(platform, externalJobId) as { application_id: string; state: string } | undefined;
  }

  ensureApplication(platform: PlatformId, externalJobId: string, at: string): string {
    const existing = this.findApplication(platform, externalJobId);
    if (existing) return existing.application_id;
    const applicationId = newId('app');
    this.store.db
      .prepare(
        `INSERT INTO applications (application_id, platform, job_external_id, state, state_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'DISCOVERED', ?, ?, ?)`,
      )
      .run(applicationId, platform, externalJobId, at, at, at);
    return applicationId;
  }

  applicationState(applicationId: string): ApplicationState {
    const row = this.store.db.prepare('SELECT state FROM applications WHERE application_id = ?').get(applicationId) as
      | { state: ApplicationState }
      | undefined;
    if (!row) throw new Error(`application 不存在: ${applicationId}`);
    return row.state;
  }

  /** 合法迁移 + 附带列更新（greeted_at / evidence 等）。非法抛 StateTransitionError。 */
  transitionApplication(
    applicationId: string,
    to: ApplicationState,
    at: string,
    cols?: Record<string, string | number | null>,
  ): void {
    const from = this.applicationState(applicationId);
    assertTransition(from, to);
    const sets = ['state = ?', 'state_updated_at = ?', 'updated_at = ?'];
    const vals: Array<string | number | null> = [to, at, at];
    for (const [k, v] of Object.entries(cols ?? {})) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(applicationId);
    this.store.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE application_id = ?`).run(...vals);
  }

  /** 不改状态的列更新（如评分/决策写入）。列名来自 DATA_MODEL §4.2 白名单。 */
  patchApplication(applicationId: string, at: string, cols: Record<string, string | number | null>): void {
    const sets = ['updated_at = ?'];
    const vals: Array<string | number | null> = [at];
    for (const [k, v] of Object.entries(cols)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(applicationId);
    this.store.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE application_id = ?`).run(...vals);
  }

  // ---------- audit_log ----------

  insertAudit(a: AuditInput): string {
    const id = newId('audit');
    this.store.db
      .prepare(
        `INSERT INTO audit_log
           (id, at, day_key, run_id, actor, category, event, entity_type, entity_id,
            payload_json, result, error_code, action_intent_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, a.at, a.dayKey, a.runId ?? null, a.actor, a.category, a.event,
        a.entityType ?? null, a.entityId ?? null, a.payloadJson ?? null, a.result,
        a.errorCode ?? null, a.actionIntentId ?? null, a.source ?? null,
      );
    return id;
  }

  // ---------- action_intents ----------

  findIntentByIdemKey(idemKey: string): { intent_id: string; state: string; attempts: number } | undefined {
    return this.store.db
      .prepare('SELECT intent_id, state, attempts FROM action_intents WHERE idem_key = ?')
      .get(idemKey) as { intent_id: string; state: string; attempts: number } | undefined;
  }

  insertIntent(input: {
    idemKey: string;
    actionType: ActionType;
    runId: string;
    platform: PlatformId;
    targetRef: string;
    payloadJson: string;
    at: string;
  }): string {
    const intentId = newId('int');
    this.store.db
      .prepare(
        `INSERT INTO action_intents (intent_id, idem_key, action_type, run_id, platform, target_ref, payload_json, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(intentId, input.idemKey, input.actionType, input.runId, input.platform, input.targetRef, input.payloadJson, input.at);
    return intentId;
  }

  markIntentExecuted(intentId: string, effectId: string | undefined, at: string, quotaTakes: boolean): void {
    this.store.db
      .prepare(
        `UPDATE action_intents SET state = 'executed', effect_id = ?, executed_at = ?, quota_taken = ?
         WHERE intent_id = ?`,
      )
      .run(effectId ?? null, at, quotaTakes ? 1 : 0, intentId);
  }

  markIntentFailed(intentId: string, reason: string, at: string): void {
    this.store.db
      .prepare(
        `UPDATE action_intents SET state = 'failed', failure_reason = ?, attempts = attempts + 1, executed_at = ?
         WHERE intent_id = ?`,
      )
      .run(reason, at, intentId);
  }

  usedQuota(platform: PlatformId, actionType: ActionType, dayKey: string): number {
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM action_intents
         WHERE platform = ? AND action_type = ? AND state = 'executed' AND quota_taken = 1 AND run_id LIKE ?`,
      )
      .get(platform, actionType, `run_${dayKey}%`) as { n: number };
    return Number(row.n);
  }

  // ---------- settings ----------

  getSetting<T>(key: string): T | undefined {
    const row = this.store.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  setSetting(key: string, value: unknown, at: string): void {
    this.store.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), at);
  }
}
