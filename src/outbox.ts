import { randomUUID } from 'node:crypto';
import { Store } from './database.js';
import { requireCondition } from './domain.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type OutboxState = 'pending' | 'running' | 'done' | 'dead';
export type OutboxEntry = {
  key: string; type: string; payload: JsonValue; revision: number; state: OutboxState;
  attempts: number; availableAt: number; leaseUntil: number | null; lastError: string | null;
};
export type OutboxJob = {
  key: string; type: string; payload: JsonValue; revision: number; attempt: number;
  leaseToken: string; leaseUntil: number;
};
export type OutboxOptions = {
  now?: () => number; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number;
};

type Row = {
  job_key: string; job_type: string; payload: string; revision: number; state: OutboxState;
  attempts: number; available_at: number; lease_owner: string | null; lease_token: string | null;
  lease_until: number | null; claimed_revision: number | null; last_error: string | null;
};

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'INVALID_JOB', 'Payload de tarefa contém um número inválido.');
    return JSON.stringify(value);
  }
  requireCondition(typeof value === 'object' && value !== null && !seen.has(value), 'INVALID_JOB', 'Payload de tarefa precisa ser JSON válido, sem ciclos.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(',')}]`;
    requireCondition(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'INVALID_JOB', 'Payload de tarefa precisa conter apenas dados JSON.');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

function entry(row: Row): OutboxEntry {
  return {
    key: row.job_key, type: row.job_type, payload: JSON.parse(row.payload) as JsonValue,
    revision: row.revision, state: row.state, attempts: row.attempts,
    availableAt: row.available_at, leaseUntil: row.lease_until, lastError: row.last_error,
  };
}

/**
 * Persistent, at-least-once delivery. Consumers must deduplicate external effects.
 * A key with an unchanged JSON payload stays completed; include a changing source
 * version in the payload when the same logical resource needs another delivery.
 * Payloads should contain resource IDs and opaque versions, never credentials.
 */
export class DurableOutbox {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly store: Store, options: OutboxOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    requireCondition(Number.isInteger(this.maxAttempts) && this.maxAttempts >= 1 && this.maxAttempts <= 100, 'INVALID_JOB_CONFIG', 'Limite de tentativas inválido.');
    requireCondition(Number.isSafeInteger(this.baseDelayMs) && this.baseDelayMs >= 1 && Number.isSafeInteger(this.maxDelayMs) && this.maxDelayMs >= this.baseDelayMs && this.maxDelayMs <= 86_400_000, 'INVALID_JOB_CONFIG', 'Intervalos de repetição inválidos.');
    store.migrateFeature('outbox', 1, `
      CREATE TABLE outbox_jobs (
        job_key TEXT PRIMARY KEY, job_type TEXT NOT NULL, payload TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('pending','running','done','dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), available_at INTEGER NOT NULL,
        lease_owner TEXT, lease_token TEXT, lease_until INTEGER, claimed_revision INTEGER,
        last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK ((state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
                AND lease_until IS NOT NULL AND claimed_revision IS NOT NULL)
               OR (state != 'running' AND lease_owner IS NULL AND lease_token IS NULL
                   AND lease_until IS NULL AND claimed_revision IS NULL))
      );
      CREATE INDEX outbox_jobs_due ON outbox_jobs(state,available_at,lease_until);
    `);
  }

  private atomically<T>(work: () => T): T {
    return this.store.db.isTransaction ? work() : this.store.transaction(work);
  }
  private row(key: string): Row | undefined {
    return this.store.db.prepare('SELECT * FROM outbox_jobs WHERE job_key=?').get(key) as Row | undefined;
  }
  private validateOwner(owner: string): void {
    requireCondition(owner.trim().length >= 1 && owner.length <= 128, 'INVALID_JOB', 'Identificação de executor inválida.');
  }
  private owned(owner: string, job: OutboxJob): Row | undefined {
    const row = this.row(job.key);
    return row && row.state === 'running' && row.lease_owner === owner
      && row.lease_token === job.leaseToken && row.claimed_revision === job.revision
      && row.lease_until! > this.now() ? row : undefined;
  }
  private pending(key: string, at: number, attempts: number, lastError: string | null): void {
    this.store.db.prepare(`UPDATE outbox_jobs SET state='pending', attempts=?, available_at=?,
      lease_owner=NULL, lease_token=NULL, lease_until=NULL, claimed_revision=NULL,
      last_error=?, updated_at=? WHERE job_key=?`).run(attempts, at, lastError, this.now(), key);
  }

  enqueue(key: string, type: string, payload: JsonValue): OutboxEntry {
    requireCondition(key.trim().length >= 1 && key.length <= 200 && /^[\w.:-]{1,64}$/.test(type), 'INVALID_JOB', 'Chave ou tipo de tarefa inválido.');
    const json = canonical(payload);
    requireCondition(Buffer.byteLength(json) <= 65_536, 'INVALID_JOB', 'Payload de tarefa excede o limite.');
    return this.atomically(() => {
      const existing = this.row(key);
      if (!existing) {
        const now = this.now();
        this.store.db.prepare(`INSERT INTO outbox_jobs
          (job_key,job_type,payload,revision,state,attempts,available_at,created_at,updated_at)
          VALUES(?,?,?,1,'pending',0,?,?,?)`).run(key, type, json, now, now, now);
      } else {
        requireCondition(existing.job_type === type, 'JOB_TYPE_CONFLICT', 'Uma chave de tarefa não pode mudar de tipo.');
        if (existing.payload === json) return entry(existing);
        this.store.db.prepare('UPDATE outbox_jobs SET payload=?,revision=revision+1,attempts=0,last_error=NULL,updated_at=? WHERE job_key=?')
          .run(json, this.now(), key);
        // An executor already holding a lease finishes only its claimed version.
        // It releases the new version to pending instead of marking it completed.
        if (existing.state !== 'running') this.pending(key, this.now(), 0, null);
      }
      return entry(this.row(key)!);
    });
  }

  claim(owner: string, leaseMs: number, types?: readonly string[]): OutboxJob | undefined {
    this.validateOwner(owner);
    requireCondition(Number.isSafeInteger(leaseMs) && leaseMs >= 1 && leaseMs <= 3_600_000, 'INVALID_JOB', 'Prazo de execução inválido.');
    requireCondition(types === undefined || (Array.isArray(types) && types.length <= 64
      && types.every(type => /^[\w.:-]{1,64}$/.test(type))), 'INVALID_JOB', 'Filtro de tipos de tarefa inválido.');
    if (types?.length === 0) return undefined;
    const scope = types ? ` AND job_type IN (${types.map(() => '?').join(',')})` : '';
    const typeParams = types ?? [];
    return this.atomically(() => {
      const now = this.now();
      this.store.db.prepare(`UPDATE outbox_jobs SET state='dead',lease_owner=NULL,lease_token=NULL,
        lease_until=NULL,claimed_revision=NULL,last_error='LEASE_EXPIRED',updated_at=?
        WHERE state='running' AND lease_until<=? AND attempts>=? AND claimed_revision=revision${scope}`)
        .run(now, now, this.maxAttempts, ...typeParams);
      const row = this.store.db.prepare(`SELECT * FROM outbox_jobs
        WHERE ((state='pending' AND available_at<=?) OR (state='running' AND lease_until<=?))${scope}
        ORDER BY available_at,created_at,job_key LIMIT 1`).get(now, now, ...typeParams) as Row | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      this.store.db.prepare(`UPDATE outbox_jobs SET state='running',attempts=attempts+1,
        lease_owner=?,lease_token=?,lease_until=?,claimed_revision=revision,updated_at=?
        WHERE job_key=?`).run(owner, token, now + leaseMs, now, row.job_key);
      return {
        key: row.job_key, type: row.job_type, payload: JSON.parse(row.payload) as JsonValue,
        revision: row.revision, attempt: row.attempts + 1, leaseToken: token, leaseUntil: now + leaseMs,
      };
    });
  }

  complete(owner: string, job: OutboxJob): boolean {
    return this.atomically(() => {
      const row = this.owned(owner, job);
      if (!row) return false;
      if (row.revision !== job.revision) this.pending(job.key, this.now(), 0, null);
      else this.store.db.prepare(`UPDATE outbox_jobs SET state='done',lease_owner=NULL,lease_token=NULL,
        lease_until=NULL,claimed_revision=NULL,last_error=NULL,updated_at=? WHERE job_key=?`).run(this.now(), job.key);
      return true;
    });
  }

  fail(owner: string, job: OutboxJob, errorCode: string): boolean {
    return this.atomically(() => {
      const row = this.owned(owner, job);
      if (!row) return false;
      // Never persist arbitrary exceptions, URLs, request bodies or credentials.
      const safeCode = /^[A-Za-z0-9_.:-]{1,80}$/.test(errorCode) ? errorCode : 'JOB_FAILED';
      if (row.revision !== job.revision) this.pending(job.key, this.now(), 0, null);
      else if (row.attempts >= this.maxAttempts) {
        this.store.db.prepare(`UPDATE outbox_jobs SET state='dead',lease_owner=NULL,lease_token=NULL,
          lease_until=NULL,claimed_revision=NULL,last_error=?,updated_at=? WHERE job_key=?`).run(safeCode, this.now(), job.key);
      } else {
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(row.attempts - 1, 30));
        this.pending(job.key, this.now() + delay, row.attempts, safeCode);
      }
      return true;
    });
  }

  get(key: string): OutboxEntry | undefined {
    const row = this.row(key); return row ? entry(row) : undefined;
  }
  stats(): Record<OutboxState, number> {
    const result: Record<OutboxState, number> = { pending: 0, running: 0, done: 0, dead: 0 };
    for (const row of this.store.db.prepare('SELECT state,COUNT(*) AS count FROM outbox_jobs GROUP BY state').all() as { state: OutboxState; count: number }[]) result[row.state] = row.count;
    return result;
  }
  retryDead(key: string): boolean {
    return this.atomically(() => {
      if (this.row(key)?.state !== 'dead') return false;
      this.store.db.prepare('UPDATE outbox_jobs SET revision=revision+1 WHERE job_key=?').run(key);
      this.pending(key, this.now(), 0, null); return true;
    });
  }
}
