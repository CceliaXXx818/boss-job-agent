import type { DatabaseSync } from 'node:sqlite';
import {
  APPLICATION_STATES,
  CONVERSATION_STATES,
  INTENT_STATES,
  MESSAGE_DIRECTIONS,
} from '@job-agent/domain';

/**
 * 版本化迁移 —— DATA_MODEL.md §4 的 DDL 落地。
 * 约定：只追加新版本，不修改已发布版本（审计/幂等约束随表结构内置）。
 * CHECK 枚举值来自 @job-agent/domain（单一来源，DDL 运行时生成）。
 */

function checkList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/** 审计 append-only 触发器（幂等安装；维护清理后需重装，见 SqliteStore.purgeAuditBefore） */
export function installAuditTriggers(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
}

export function dropAuditTriggers(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_update;');
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_delete;');
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init-schema-2026-09-04',
    up(db) {
      db.exec(`
        -- 4.1 岗位快照（发现即 upsert；去重键 platform+external_id）
        CREATE TABLE candidate_jobs (
          id               TEXT PRIMARY KEY,
          platform         TEXT NOT NULL,
          external_id      TEXT NOT NULL,
          url              TEXT NOT NULL,
          fingerprint      TEXT NOT NULL,
          title            TEXT NOT NULL,
          company          TEXT NOT NULL,
          city             TEXT NOT NULL,
          salary_text      TEXT,
          salary_min_k     INTEGER,
          salary_max_k     INTEGER,
          experience_required TEXT,
          education_required  TEXT,
          tags_json        TEXT,
          job_type         TEXT,
          description      TEXT NOT NULL,
          hr_name          TEXT,
          hr_title         TEXT,
          first_seen_day   TEXT NOT NULL,
          latest_seen_day  TEXT NOT NULL,
          seen_count       INTEGER NOT NULL DEFAULT 1,
          is_active        INTEGER NOT NULL DEFAULT 1,
          discovered_at    TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          UNIQUE(platform, external_id)
        );
        CREATE INDEX idx_candidate_jobs_platform_fingerprint ON candidate_jobs(platform, fingerprint);
        CREATE INDEX idx_candidate_jobs_latest_seen_day   ON candidate_jobs(latest_seen_day);

        -- 4.2 投递状态机（一岗位一管道记录；CHECK 兜底非法状态）
        CREATE TABLE applications (
          application_id       TEXT PRIMARY KEY,
          platform             TEXT NOT NULL,
          job_external_id      TEXT NOT NULL,
          state                TEXT NOT NULL CHECK(state IN (${checkList(APPLICATION_STATES)})),
          state_updated_at     TEXT NOT NULL,
          conversation_id      TEXT,
          score_total          REAL,
          score_dims_json      TEXT,
          rubric_version       TEXT,
          evidence_json        TEXT,
          hard_filter_reason   TEXT,
          decision             TEXT,
          greeting_template_id TEXT,
          greeting_text_snapshot TEXT,
          greeted_at           TEXT,
          greeting_effect_id   TEXT,
          resume_sent_at       TEXT,
          resume_mode          TEXT,
          hr_last_reply_at     TEXT,
          next_action          TEXT,
          failure_reason       TEXT,
          needs_human_reason   TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          UNIQUE(platform, job_external_id)
        );
        CREATE INDEX idx_applications_state_decision ON applications(state, decision);
        CREATE INDEX idx_applications_platform_state ON applications(platform, state);
        CREATE INDEX idx_applications_hr_last_reply_at ON applications(hr_last_reply_at);

        -- 4.3 会话线程（水位线 + 冻结状态）
        CREATE TABLE conversations (
          conversation_id              TEXT PRIMARY KEY,
          platform                     TEXT NOT NULL,
          external_conversation_id     TEXT,
          job_external_id              TEXT NOT NULL,
          hr_name                      TEXT,
          last_seen_platform_message_id TEXT,
          state                        TEXT NOT NULL DEFAULT 'active'
                                          CHECK(state IN (${checkList(CONVERSATION_STATES)})),
          frozen_reason                TEXT,
          frozen_at                    TEXT,
          created_at                   TEXT NOT NULL,
          updated_at                   TEXT NOT NULL,
          UNIQUE(platform, external_conversation_id)
        );

        -- 4.4 消息逐条（HR 平台消息 ID 幂等去重）
        CREATE TABLE messages (
          message_id           TEXT PRIMARY KEY,
          conversation_id      TEXT NOT NULL REFERENCES conversations(conversation_id),
          platform_message_id  TEXT,
          direction            TEXT NOT NULL CHECK(direction IN (${checkList(MESSAGE_DIRECTIONS)})),
          text                 TEXT NOT NULL,
          sent_at              TEXT NOT NULL,
          intent               TEXT,
          intent_confidence    REAL,
          policy_bucket        TEXT,
          classification_method TEXT,
          classification_version TEXT,
          processed_at         TEXT,
          action_intent_id     TEXT,
          is_hidden            INTEGER,
          UNIQUE(conversation_id, platform_message_id)
        );
        CREATE INDEX idx_messages_conversation_sent ON messages(conversation_id, sent_at);

        -- 4.5 对外写操作登记账本（幂等键唯一 → 绝不重复执行）
        CREATE TABLE action_intents (
          intent_id      TEXT PRIMARY KEY,
          idem_key       TEXT NOT NULL UNIQUE,
          action_type    TEXT NOT NULL,
          run_id         TEXT NOT NULL,
          platform       TEXT NOT NULL,
          target_ref     TEXT NOT NULL,
          payload_json   TEXT NOT NULL,
          state          TEXT NOT NULL CHECK(state IN (${checkList(INTENT_STATES)})),
          quota_taken    INTEGER NOT NULL DEFAULT 0,
          effect_id      TEXT,
          failure_reason TEXT,
          attempts       INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL,
          executed_at    TEXT
        );

        -- 4.6 审计日志（append-only：触发器拒绝任何 UPDATE/DELETE）
        CREATE TABLE audit_log (
          id             TEXT PRIMARY KEY,
          at             TEXT NOT NULL,
          day_key        TEXT NOT NULL,
          run_id         TEXT,
          actor          TEXT NOT NULL,
          category       TEXT NOT NULL,
          event          TEXT NOT NULL,
          entity_type    TEXT,
          entity_id      TEXT,
          before_json    TEXT,
          after_json     TEXT,
          payload_json   TEXT,
          result         TEXT NOT NULL,
          error_code     TEXT,
          action_intent_id TEXT,
          source         TEXT
        );
        CREATE INDEX idx_audit_log_day_actor     ON audit_log(day_key, actor);
        CREATE INDEX idx_audit_log_entity        ON audit_log(entity_type, entity_id);
        CREATE INDEX idx_audit_log_run_id        ON audit_log(run_id);
        CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
        CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

        -- 4.7 运行记录（日报数据源）
        CREATE TABLE runs (
          run_id         TEXT PRIMARY KEY,
          kind           TEXT NOT NULL,
          day_key        TEXT NOT NULL,
          started_at     TEXT NOT NULL,
          finished_at    TEXT,
          status         TEXT NOT NULL,
          summary_json   TEXT,
          report_md_path TEXT,
          report_csv_path TEXT,
          exceptions_json TEXT
        );

        -- 4.8 系统 kv
        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set<number>();
  for (const row of db.prepare('SELECT version FROM schema_migrations').all()) {
    applied.add(Number((row as { version: number }).version));
  }
  const insert = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      insert.run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version}(${m.name}) 失败: ${(e as Error).message}`, { cause: e });
    }
  }
}
