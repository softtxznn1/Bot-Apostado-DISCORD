import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../domain.js';

export const roomsHealthFile = (env: NodeJS.ProcessEnv = process.env): string => env.ROOMS_HEALTH_FILE || join(tmpdir(), 'ff-salas-health.json');
export function checkRoomsDatabase(database: DatabaseSync): void {
  database.prepare('SELECT id FROM managed_rooms LIMIT 1').get();
  // Enter SQLite's write path without changing any record or producing audit events.
  database.prepare('UPDATE managed_rooms SET updated_at=updated_at WHERE 0').run();
}
type Snapshot = { version: 1; pid: number; checkedAt: number; discordReady: boolean; databaseOk: boolean };
type MonitorOptions = {
  file: string; discordReady: () => boolean; checkDatabase: () => void;
  onError: (error: unknown) => void; now?: () => number; intervalMs?: number;
};
function readSnapshot(file: string): Snapshot | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as Partial<Snapshot> | null;
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid! < 1
      || !Number.isSafeInteger(value.checkedAt) || value.checkedAt! < 1
      || typeof value.discordReady !== 'boolean' || typeof value.databaseOk !== 'boolean') return undefined;
    return value as Snapshot;
  } catch { return undefined; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Local liveness only: neither the provider nor the game is certified here. */
export function checkRoomsHealth(file = roomsHealthFile(), now = Date.now(), alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
}): { healthy: boolean; reason: string; liveRoomsVerified: false } {
  const snapshot = readSnapshot(file);
  let reason = 'HEALTH_SNAPSHOT_MISSING_OR_INVALID';
  if (snapshot) {
    if (now < snapshot.checkedAt || now - snapshot.checkedAt > 35_000) reason = 'HEALTH_HEARTBEAT_STALE';
    else if (!alive(snapshot.pid)) reason = 'HEALTH_PROCESS_STOPPED';
    else if (!snapshot.discordReady) reason = 'HEALTH_DISCORD_DISCONNECTED';
    else if (!snapshot.databaseOk) reason = 'HEALTH_DATABASE_UNAVAILABLE';
    else reason = 'HEALTH_OK';
  }
  return { healthy: reason === 'HEALTH_OK', reason, liveRoomsVerified: false };
}

/** Small atomic heartbeat, without credentials, room data or production DB changes. */
export class RoomsHealthMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  constructor(private readonly options: MonitorOptions) { this.now = options.now ?? Date.now; }
  sample(): void {
    let databaseOk = false;
    try { this.options.checkDatabase(); databaseOk = true; } catch { /* Keep the heartbeat explicit about failed storage. */ }
    const snapshot: Snapshot = { version: 1, pid: process.pid, checkedAt: this.now(), discordReady: this.options.discordReady(), databaseOk };
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.options.file);
    } catch { throw new DomainError('ROOM_HEALTH_WRITE', 'Não foi possível atualizar o indicador local de saúde. Confira o diretório temporário.'); }
    finally { rmSync(temporary, { force: true }); }
  }
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => {
      try { this.sample(); } catch (error) { this.options.onError(error); }
    }, this.options.intervalMs ?? 10_000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A second process, if mistakenly started, must not erase a different owner.
    if (readSnapshot(this.options.file)?.pid === process.pid) rmSync(this.options.file, { force: true });
  }
}
