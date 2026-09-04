import { localDateKey } from '../clock';
import type { AgentRepo } from '../store/repo';

/** 保留期清理（P2-⑤ / Q10 默认：JD 180 天、消息 180 天、审计 1 年）。 */
export interface RetentionPolicy {
  jobDescriptionDays: number;
  messageDays: number;
  auditDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  jobDescriptionDays: 180,
  messageDays: 180,
  auditDays: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupCounts {
  jobDescriptionsCleared: number;
  messagesDeleted: number;
  auditDeleted: number;
}

export function cleanupExpiredData(repo: AgentRepo, at: Date, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): CleanupCounts {
  const jobCutoffDay = localDateKey(new Date(at.getTime() - policy.jobDescriptionDays * DAY_MS));
  const r1 = repo.store.db
    .prepare(
      `UPDATE candidate_jobs SET description = '<已按保留策略清理>', updated_at = ?
       WHERE latest_seen_day < ?`,
    )
    .run(at.toISOString(), jobCutoffDay);

  const messageCutoff = new Date(at.getTime() - policy.messageDays * DAY_MS).toISOString();
  const r2 = repo.store.db.prepare('DELETE FROM messages WHERE sent_at < ?').run(messageCutoff);

  const auditCutoff = new Date(at.getTime() - policy.auditDays * DAY_MS).toISOString();
  const r3 = repo.store.purgeAuditBefore(auditCutoff);

  return {
    jobDescriptionsCleared: Number(r1.changes),
    messagesDeleted: Number(r2.changes),
    auditDeleted: r3,
  };
}
