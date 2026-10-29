import { createHash } from 'node:crypto';
import { requireCondition } from '../domain.js';
import { DurableOutbox, type JsonValue, type OutboxState } from '../outbox.js';
import { ManagedRoomsService } from './service.js';
import type { RoomActor } from './types.js';

const deliveryTypes = ['managed_room_publish', 'managed_room_panel', 'managed_room_audit', 'managed_room_redact'] as const;
const safeErrors = new Set(['ROOMS_NOT_CONFIGURED', 'ROOM_ACCESS_UNKNOWN', 'ROOM_BOT_PERMISSIONS', 'ROOM_CHANNEL_UNAVAILABLE',
  'ROOM_DELIVERY_FAILED', 'ROOM_GUILD_MISMATCH', 'ROOM_JOB_INVALID', 'ROOM_MESSAGE_AUTHOR', 'ROOM_PUBLIC_CHANNEL',
  'ROOM_SETTINGS_CHANGED', 'ROOM_UNAUTHORIZED_MEMBER', 'ROOM_UNAUTHORIZED_ROLE', 'LEASE_EXPIRED', 'JOB_FAILED']);
const scope = `job_type IN (${deliveryTypes.map(() => '?').join(',')}) AND json_type(payload)='object' AND json_extract(payload,'$.guildId')=?`;
const reference = (guildId: string, key: string) => createHash('sha256').update(JSON.stringify([guildId, key])).digest('hex').slice(0, 32);
type Row = { job_key: string; job_type: string; state: OutboxState; attempts: number; available_at: number;
  lease_until: number | null; last_error: string | null; revision: number };
export type RoomDeliveryTask = { reference: string; type: string; state: OutboxState; attempts: number;
  availableAt: number; leaseUntil: number | null; lastError: string | null };
export type RoomDeliveryDiagnosis = { page: number; pageSize: number; total: number; counts: Record<OutboxState, number>; items: RoomDeliveryTask[] };

/** Recovery is limited to Discord delivery jobs. It never repeats a room API operation. */
export class RoomDeliveryOperations {
  private readonly outbox: DurableOutbox;
  constructor(private readonly service: ManagedRoomsService, private readonly now = Date.now) {
    this.outbox = new DurableOutbox(service.store);
    service.store.migrateFeature('managed_room_delivery_operations', 1, `
      CREATE TABLE managed_room_delivery_retries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
        task_reference TEXT NOT NULL, job_type TEXT NOT NULL,
        actor_id TEXT NOT NULL, reason TEXT NOT NULL,
        previous_revision INTEGER NOT NULL, next_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX managed_room_delivery_retry_guild ON managed_room_delivery_retries(guild_id,id);
      CREATE TRIGGER managed_room_delivery_retry_no_update BEFORE UPDATE ON managed_room_delivery_retries
        BEGIN SELECT RAISE(ABORT,'delivery retry events are append-only'); END;
      CREATE TRIGGER managed_room_delivery_retry_no_delete BEFORE DELETE ON managed_room_delivery_retries
        BEGIN SELECT RAISE(ABORT,'delivery retry events are append-only'); END;
    `);
  }
  private authorize(guildId: string, actor: RoomActor): void {
    const settings = this.service.settings(guildId);
    requireCondition(settings, 'ROOMS_NOT_CONFIGURED', 'Configure as salas antes de consultar as entregas.');
    requireCondition(actor.administrator || settings.managerRoleIds.some(role => actor.roleIds.includes(role)),
      'FORBIDDEN', 'Somente a administração e a gerência podem consultar ou recuperar entregas de salas.');
  }
  diagnose(guildId: string, actor: RoomActor, page = 1): RoomDeliveryDiagnosis {
    this.authorize(guildId, actor);
    requireCondition(Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000, 'ROOM_PAGE', 'Página de entregas inválida.');
    const counts: Record<OutboxState, number> = { pending: 0, running: 0, done: 0, dead: 0 };
    const params = [...deliveryTypes, guildId];
    const groups = this.service.store.db.prepare(`SELECT state,COUNT(*) AS total FROM outbox_jobs WHERE ${scope} GROUP BY state`).all(...params) as { state: OutboxState; total: number }[];
    for (const group of groups) counts[group.state] = group.total;
    const pageSize = 10;
    const rows = this.service.store.db.prepare(`SELECT job_key,job_type,state,attempts,available_at,lease_until,last_error,revision
      FROM outbox_jobs WHERE ${scope} ORDER BY CASE state WHEN 'dead' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,updated_at DESC,job_key
      LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    return { page, pageSize, total: Object.values(counts).reduce((sum, value) => sum + value, 0), counts,
      items: rows.map(task => ({ reference: reference(guildId, task.job_key), type: task.job_type,
        state: task.state, attempts: task.attempts, availableAt: task.available_at, leaseUntil: task.lease_until,
        lastError: task.last_error === null ? null : safeErrors.has(task.last_error) ? task.last_error : 'ROOM_DELIVERY_FAILED' })) };
  }
  retry(guildId: string, actor: RoomActor, taskReference: string, reason: string): { reference: string; revision: number } {
    this.authorize(guildId, actor);
    requireCondition(/^[a-f0-9]{32}$/.test(taskReference), 'ROOM_TASK_REFERENCE', 'Use a referência de tarefa exibida em /salas diagnostico.');
    requireCondition(typeof reason === 'string' && reason.trim().length >= 3 && reason.length <= 300
      && !/[\u0000-\u001f\u007f]/.test(reason), 'ROOM_RETRY_REASON', 'Informe um motivo de 3 a 300 caracteres, sem controles.');
    const work = () => {
      this.authorize(guildId, actor);
      const rows = this.service.store.db.prepare(`SELECT job_key,job_type,state,revision FROM outbox_jobs WHERE ${scope}`)
        .all(...deliveryTypes, guildId) as Pick<Row, 'job_key' | 'job_type' | 'state' | 'revision'>[];
      const task = rows.find(row => reference(guildId, row.job_key) === taskReference);
      requireCondition(task, 'ROOM_DELIVERY_NOT_FOUND', 'Tarefa de entrega não encontrada neste servidor.');
      requireCondition(task.state === 'dead', 'ROOM_DELIVERY_NOT_FAILED', 'Somente entregas com tentativas esgotadas podem ser reprocessadas.');
      const entry = this.outbox.get(task.job_key)!;
      let safeReason = reason.trim();
      const payload = entry.payload as Record<string, JsonValue>;
      if (typeof payload.id === 'string') {
        try {
          const room = this.service.getForDelivery(guildId, payload.id);
          for (const secret of [room.options.password, room.confirmed?.password, room.pending?.requestedOptions?.password]) {
            if (secret) safeReason = safeReason.split(secret).join('[REDACTED]');
          }
        } catch { /* Invalid room metadata is left for delivery validation, never disclosed here. */ }
      }
      requireCondition(this.outbox.retryDead(task.job_key), 'ROOM_DELIVERY_NOT_FAILED', 'A entrega já foi recuperada ou mudou de estado.');
      this.service.store.db.prepare(`INSERT INTO managed_room_delivery_retries
        (guild_id,task_reference,job_type,actor_id,reason,previous_revision,next_revision,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(guildId, taskReference, task.job_type, actor.userId, safeReason, task.revision, task.revision + 1, this.now());
      return { reference: taskReference, revision: task.revision + 1 };
    };
    return this.service.store.db.isTransaction ? work() : this.service.store.transaction(work);
  }
}
