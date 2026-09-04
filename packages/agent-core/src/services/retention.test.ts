import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@job-agent/sqlite-store';
import { virtualClock } from '../clock';
import { AgentRepo } from '../store/repo';
import { cleanupExpiredData } from './retention';

function seed() {
  const clock = virtualClock('2026-09-04T02:00:00.000Z');
  const store = SqliteStore.open(':memory:');
  store.migrate();
  const repo = new AgentRepo(store);
  const at = () => clock.now().toISOString();
  const day = () => clock.todayKey();

  // 一条旧岗位（2026-01 前被看见）与一条新岗位
  repo.upsertCandidate({ externalId: 'OLD', url: 'u', fingerprint: 'f1', title: 't', company: 'c', city: '深圳', description: '旧 JD 原文', dayKey: '2025-12-01', at: '2025-12-01T00:00:00.000Z' });
  repo.upsertCandidate({ externalId: 'NEW', url: 'u', fingerprint: 'f2', title: 't', company: 'c', city: '杭州', description: '新 JD 原文', dayKey: '2026-09-01', at: '2026-09-01T00:00:00.000Z' });
  // 旧/新消息
  repo.store.db.prepare(`INSERT INTO conversations (conversation_id, platform, job_external_id, created_at, updated_at) VALUES ('cv1','mock','OLD','2025-12-01T00:00:00.000Z','2025-12-01T00:00:00.000Z')`).run();
  repo.store.db.prepare(`INSERT INTO conversations (conversation_id, platform, job_external_id, created_at, updated_at) VALUES ('cv2','mock','NEW','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run();
  repo.store.db.prepare(`INSERT INTO messages (message_id, conversation_id, direction, text, sent_at) VALUES ('m-old','cv1','hr','旧消息','2025-12-01T00:00:00.000Z')`).run();
  repo.store.db.prepare(`INSERT INTO messages (message_id, conversation_id, direction, text, sent_at) VALUES ('m-new','cv2','hr','新消息',?)`).run(at());
  // 旧/新审计
  repo.insertAudit({ at: '2024-01-01T00:00:00.000Z', dayKey: '2024-01-01', actor: 'system', category: 'report', event: 'report.generated', result: 'ok' });
  repo.insertAudit({ at: at(), dayKey: day(), actor: 'system', category: 'config_load', event: 'config.loaded', result: 'ok' });
  return { clock, store, repo };
}

describe('retention：保留期清理（Q10 默认：JD/消息 180 天、审计 365 天）', () => {
  it('到期数据被清理，未到期保留，审计 append-only 语义恢复', () => {
    const { clock, store, repo } = seed();
    const counts = cleanupExpiredData(repo, clock.now());
    expect(counts.jobDescriptionsCleared).toBe(1);
    expect(counts.messagesDeleted).toBe(1);
    expect(counts.auditDeleted).toBe(1);

    const oldDesc = repo.store.db.prepare(`SELECT description FROM candidate_jobs WHERE external_id = 'OLD'`).get() as { description: string };
    const newDesc = repo.store.db.prepare(`SELECT description FROM candidate_jobs WHERE external_id = 'NEW'`).get() as { description: string };
    expect(oldDesc.description).toContain('保留策略');
    expect(newDesc.description).toBe('新 JD 原文');

    const msgs = repo.store.db.prepare(`SELECT COUNT(*) AS n FROM messages`).all() as Array<{ n: number }>;
    expect(msgs[0]?.n).toBe(1);

    // 审计触发器已重装：删除/更新仍被拒
    expect(() => repo.store.db.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/);
    expect(() => repo.store.db.prepare(`UPDATE audit_log SET result='x'`).run()).toThrow(/append-only/);

    store.close();
  });

  it('无到期数据时清理为 0 副作用', () => {
    const { clock, store, repo } = seed();
    const counts = cleanupExpiredData(repo, clock.now(), { jobDescriptionDays: 9999, messageDays: 9999, auditDays: 9999 });
    expect(counts).toEqual({ jobDescriptionsCleared: 0, messagesDeleted: 0, auditDeleted: 0 });
    store.close();
  });
});
