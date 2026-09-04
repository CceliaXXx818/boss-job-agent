import { DatabaseSync } from 'node:sqlite';
import { dropAuditTriggers, installAuditTriggers, runMigrations } from './migrations';

/**
 * SQLite 访问层（P0 骨架）—— DATA_MODEL §1 约定落地。
 * 选型：node:sqlite（Node ≥ 22.13 免 flag，零原生依赖；决策记录见 IMPLEMENTATION_PLAN P0-D4）。
 */
export class SqliteStore {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 打开（或创建）数据库文件；':memory:' 用于测试。 */
  static open(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    const store = new SqliteStore(db);
    store.initPragmas(path);
    return store;
  }

  private initPragmas(path: string): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    }
  }

  migrate(): void {
    runMigrations(this.db);
  }

  /** PRAGMA integrity_check 结果（'ok' 为通过） */
  integrityCheck(): string {
    const rows = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    return rows.map((r) => r.integrity_check).join('\n');
  }

  /** 业务表清单（排除 sqlite_* 与 schema_migrations） */
  tables(): string[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  appliedMigrations(): number[] {
    const rows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
    }>;
    return rows.map((r) => r.version);
  }

  /**
   * 维护清理：按时间删除到期审计行（P2-⑤）。
   * append-only 语义不变：临时摘除触发器→删除→重装；若中途异常由调用方保证后续一致性。
   */
  purgeAuditBefore(cutoffIso: string): number {
    dropAuditTriggers(this.db);
    try {
      const r = this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoffIso);
      return Number(r.changes);
    } finally {
      installAuditTriggers(this.db);
    }
  }

  close(): void {
    this.db.close();
  }
}
