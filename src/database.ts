import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) throw new Error('Banco criado por uma versão mais recente do bot.');
    if (version.user_version === 0) this.transaction(() => {
      const lockedVersion = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (lockedVersion.user_version === 1) return;
      if (lockedVersion.user_version !== 0) throw new Error('Versão de banco não suportada.');
      this.db.exec(`
        CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE queues (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(guild_id),
          team_size INTEGER NOT NULL CHECK(team_size BETWEEN 1 AND 4), platform TEXT NOT NULL,
          rules TEXT NOT NULL, stake_cents INTEGER NOT NULL CHECK(stake_cents >= 0),
          channel_id TEXT, message_id TEXT,
          UNIQUE(guild_id, team_size, platform, rules, stake_cents)
        );
        CREATE TABLE matches (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(guild_id),
          state TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE TABLE reservations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL, queue_id TEXT REFERENCES queues(id), match_id TEXT REFERENCES matches(id),
          UNIQUE(guild_id,user_id), CHECK ((queue_id IS NULL) != (match_id IS NULL))
        );
        CREATE TABLE blacklist (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL,
          PRIMARY KEY(guild_id,user_id)
        );
        CREATE TABLE audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
          subject_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
          created_at INTEGER NOT NULL, details TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX matches_guild_state ON matches(guild_id,state);
        CREATE INDEX reservations_queue ON reservations(queue_id,id);
        PRAGMA user_version=1;
      `);
    });
    this.db.exec('CREATE TABLE IF NOT EXISTS feature_migrations (feature TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  }

  migrateFeature(feature: string, version: number, sql: string, latestSupportedVersion = version): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT version FROM feature_migrations WHERE feature=?').get(feature) as { version: number } | undefined;
      if (current && current.version > latestSupportedVersion) throw new Error('Módulo de banco criado por uma versão mais recente.');
      if (current && current.version >= version) return;
      if (version !== (current?.version ?? 0) + 1) throw new Error('Sequência de migração de módulo inválida.');
      this.db.exec(sql);
      this.db.prepare('INSERT INTO feature_migrations(feature,version) VALUES(?,?) ON CONFLICT(feature) DO UPDATE SET version=excluded.version').run(feature, version);
    });
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
