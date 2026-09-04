import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from './store';

const EXPECTED_TABLES = [
  'action_intents',
  'applications',
  'audit_log',
  'candidate_jobs',
  'conversations',
  'messages',
  'runs',
  'settings',
];

function openMemory(): SqliteStore {
  const s = SqliteStore.open(':memory:');
  s.migrate();
  return s;
}

describe('sqlite-store: 迁移与结构（DATA_MODEL §4）', () => {
  it('迁移后 8 张业务表齐全且完整性 ok', () => {
    const s = openMemory();
    try {
      expect(s.tables().sort()).toEqual([...EXPECTED_TABLES].sort());
      expect(s.integrityCheck()).toBe('ok');
    } finally {
      s.close();
    }
  });

  it('迁移幂等：重复执行不报错、不重复登记', () => {
    const s = openMemory();
    try {
      s.migrate();
      expect(s.appliedMigrations()).toEqual([1]);
    } finally {
      s.close();
    }
  });

  it('文件库同样可用（临时目录真实落盘）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-agent-store-'));
    const path = join(dir, 't.db');
    const s = SqliteStore.open(path);
    s.migrate();
    expect(s.integrityCheck()).toBe('ok');
    s.close();
  });
});

describe('sqlite-store: 约束（幂等/CHECK/审计不可变）', () => {
  const now = '2026-09-04T00:00:00.000Z';
  const day = '2026-09-04';

  function insertJob(s: SqliteStore, externalId: string): void {
    s.db
      .prepare(
        `INSERT INTO candidate_jobs
           (id, platform, external_id, url, fingerprint, title, company, city, description,
            first_seen_day, latest_seen_day, discovered_at, updated_at)
         VALUES (?, 'mock', ?, 'http://mock/job', ?, 'AI产品经理', '示例公司', '深圳', 'JD 正文',
            ?, ?, ?, ?)`,
      )
      .run(`job-${externalId}`, externalId, `fp-${externalId}`, day, day, now, now);
  }

  it('同一 platform+external_id 只允许一条岗位快照（去重键）', () => {
    const s = openMemory();
    try {
      insertJob(s, 'MOCK-1');
      expect(() => insertJob(s, 'MOCK-1')).toThrow(/UNIQUE constraint failed/);
    } finally {
      s.close();
    }
  });

  it('application.state 非法值被 CHECK 拒绝', () => {
    const s = openMemory();
    try {
      insertJob(s, 'MOCK-2');
      expect(() =>
        s.db
          .prepare(
            `INSERT INTO applications
               (application_id, platform, job_external_id, state, state_updated_at, created_at, updated_at)
             VALUES (?, 'mock', 'MOCK-2', 'BOGUS', ?, ?, ?)`,
          )
          .run('app-1', now, now, now),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      s.close();
    }
  });

  it('audit_log append-only：UPDATE 与 DELETE 都被触发器拒绝', () => {
    const s = openMemory();
    try {
      s.db
        .prepare(
          `INSERT INTO audit_log (id, at, day_key, actor, category, event, result)
           VALUES ('audit-1', ?, ?, 'system', 'config_load', 'config.loaded', 'ok')`,
        )
        .run(now, day);
      expect(() => s.db.prepare(`UPDATE audit_log SET result = 'x' WHERE id = 'audit-1'`).run()).toThrow(
        /audit_log is append-only/,
      );
      expect(() => s.db.prepare(`DELETE FROM audit_log WHERE id = 'audit-1'`).run()).toThrow(
        /audit_log is append-only/,
      );
    } finally {
      s.close();
    }
  });

  it('action_intents.idem_key 唯一：重复登记被拒（幂等键的 DB 兜底）', () => {
    const s = openMemory();
    try {
      const insert = s.db.prepare(
        `INSERT INTO action_intents
           (intent_id, idem_key, action_type, run_id, platform, target_ref, payload_json, state, created_at)
         VALUES (?, ?, 'send_greeting', ?, 'mock', 'job:MOCK-1', '{}', 'pending', ?)`,
      );
      insert.run('intent-1', 'send_greeting:mock:job:MOCK-1:t1:2026-09-04', `run_${day}`, now);
      expect(() =>
        insert.run('intent-2', 'send_greeting:mock:job:MOCK-1:t1:2026-09-04', `run_${day}`, now),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      s.close();
    }
  });
});
