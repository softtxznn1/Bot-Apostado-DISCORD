import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Store } from '../database.js';
import { requireCondition } from '../domain.js';
import type { ManagedRoomProvider, ProviderRoom, RoomCatalog, RoomOptions } from './types.js';

const catalog: RoomCatalog = {
  revision: 'demo-v1',
  maps: [{ id: 'demo-island', label: 'Ilha — DEMONSTRAÇÃO' }, { id: 'demo-desert', label: 'Deserto — DEMONSTRAÇÃO' }],
  modes: [
    { id: 'demo-standard', label: 'Padrão — DEMONSTRAÇÃO', mapIds: ['demo-island', 'demo-desert'], minPlayers: 2, maxPlayers: 50, playerStep: 1, editableFields: ['name', 'modeId', 'mapId', 'maxPlayers', 'password'],
      optionFields: [
        { id: 'friendlyFire', label: 'Fogo amigo (demo)', type: 'boolean', editable: true },
        { id: 'rounds', label: 'Rodadas (demo)', type: 'integer', min: 1, max: 13, editable: true },
        { id: 'loot', label: 'Equipamento (demo)', type: 'choice', editable: true, choices: [{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'Ampliado' }] },
      ] },
    { id: 'demo-duel', label: 'Duelo — DEMONSTRAÇÃO', mapIds: ['demo-island'], minPlayers: 2, maxPlayers: 8, playerStep: 2, editableFields: ['name', 'modeId', 'mapId', 'maxPlayers', 'password'],
      optionFields: [{ id: 'rounds', label: 'Rodadas (demo)', type: 'integer', min: 1, max: 13, editable: true }] },
  ],
  capabilities: { create: true, lookup: true, query: true, update: true, cancel: true, close: true },
};
const keyValid = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const canonical = (options: RoomOptions) => JSON.stringify({ ...options, extras: Object.fromEntries(Object.entries(options.extras).sort(([a], [b]) => a.localeCompare(b))) });
type Row = { payload: string; original_request: string };

/** Simulação persistente, sem comunicação com Discord, Free Fire ou provedor comercial. */
export class SimulatedManagedRoomProvider implements ManagedRoomProvider {
  readonly source = 'simulated' as const;
  readonly identity = 'managed-room-simulation-v1';
  constructor(private readonly store: Store) {
    store.migrateFeature('simulated_room_provider', 1, `
      CREATE TABLE simulated_room_resources (
        remote_id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, original_request TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE simulated_room_requests (
        request_key TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL
      );
    `);
  }
  [inspect.custom](): string { return 'SimulatedManagedRoomProvider { source: simulated }'; }
  async getCatalog(): Promise<RoomCatalog> { return structuredClone(catalog); }
  private atomically<T>(work: () => T): T { return this.store.db.isTransaction ? work() : this.store.transaction(work); }
  private options(options: RoomOptions): RoomOptions {
    requireCondition(typeof options.name === 'string' && options.name.trim().length > 0 && options.name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(options.name), 'ROOM_OPTIONS', 'Nome de sala inválido.');
    requireCondition(options.password === undefined || (typeof options.password === 'string' && options.password.length >= 1 && options.password.length <= 64 && !/[\u0000-\u001f\u007f]/.test(options.password)), 'ROOM_OPTIONS', 'Senha de sala inválida.');
    const mode = catalog.modes.find(m => m.id === options.modeId);
    requireCondition(mode && mode.mapIds.includes(options.mapId), 'ROOM_OPTIONS', 'Modo/mapa de demonstração incompatível.');
    requireCondition(Number.isSafeInteger(options.maxPlayers) && options.maxPlayers >= mode.minPlayers && options.maxPlayers <= mode.maxPlayers
      && (options.maxPlayers - mode.minPlayers) % (mode.playerStep ?? 1) === 0, 'ROOM_OPTIONS', 'Capacidade de demonstração inválida.');
    requireCondition(options.extras && typeof options.extras === 'object' && !Array.isArray(options.extras), 'ROOM_OPTIONS', 'Opções extras inválidas.');
    for (const [id, value] of Object.entries(options.extras)) {
      const field = mode.optionFields.find(f => f.id === id);
      requireCondition(field && !['__proto__', 'prototype', 'constructor'].includes(id), 'ROOM_OPTIONS', 'Opção extra não suportada.');
      if (field.type === 'boolean') requireCondition(typeof value === 'boolean', 'ROOM_OPTIONS', 'Opção booleana inválida.');
      else if (field.type === 'integer') requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= (field.min ?? Number.MIN_SAFE_INTEGER) && value <= (field.max ?? Number.MAX_SAFE_INTEGER), 'ROOM_OPTIONS', 'Opção numérica inválida.');
      else if (field.type === 'choice') requireCondition(typeof value === 'string' && field.choices!.some(c => c.value === value), 'ROOM_OPTIONS', 'Escolha extra inválida.');
      else requireCondition(typeof value === 'string' && value.length <= (field.maxLength ?? 100), 'ROOM_OPTIONS', 'Opção de texto inválida.');
    }
    for (const f of mode.optionFields) requireCondition(!f.required || options.extras[f.id] !== undefined, 'ROOM_OPTIONS', 'Uma opção obrigatória está ausente.');
    return structuredClone(options);
  }
  private replay(key: string, request: string, work: () => ProviderRoom): ProviderRoom {
    requireCondition(keyValid(key), 'ROOM_REFERENCE', 'Chave de operação inválida.');
    return this.atomically(() => {
      const cached = this.store.db.prepare('SELECT request,response FROM simulated_room_requests WHERE request_key=?').get(key) as { request: string; response: string } | undefined;
      if (cached) {
        requireCondition(cached.request === request, 'ROOM_IDEMPOTENCY_CONFLICT', 'Chave de operação já utilizada com outros parâmetros.');
        return JSON.parse(cached.response) as ProviderRoom;
      }
      const room = work();
      this.store.db.prepare('INSERT INTO simulated_room_requests(request_key,request,response) VALUES(?,?,?)').run(key, request, JSON.stringify(room));
      return room;
    });
  }
  private read(id: string): ProviderRoom {
    requireCondition(keyValid(id), 'ROOM_REFERENCE', 'Identificador de sala inválido.');
    const row = this.store.db.prepare('SELECT payload FROM simulated_room_resources WHERE remote_id=?').get(id) as Row | undefined;
    requireCondition(row, 'ROOM_REMOTE_NOT_FOUND', 'Sala de demonstração não encontrada.'); return JSON.parse(row.payload) as ProviderRoom;
  }
  private save(room: ProviderRoom): ProviderRoom {
    this.store.db.prepare('UPDATE simulated_room_resources SET payload=? WHERE remote_id=?').run(JSON.stringify(room), room.id);
    return room;
  }
  async createRoom(request: { reference: string; options: RoomOptions; idempotencyKey: string }): Promise<ProviderRoom> {
    requireCondition(keyValid(request.reference), 'ROOM_REFERENCE', 'Referência de criação inválida.');
    const options = this.options(request.options); const original = canonical(options);
    return this.replay(request.idempotencyKey, JSON.stringify(['create', request.reference, original]), () => {
      const existing = this.store.db.prepare('SELECT payload,original_request FROM simulated_room_resources WHERE reference=?').get(request.reference) as Row | undefined;
      if (existing) {
        requireCondition(existing.original_request === original, 'ROOM_IDEMPOTENCY_CONFLICT', 'Referência de sala já usada com outras opções.');
        return JSON.parse(existing.payload) as ProviderRoom;
      }
      const room: ProviderRoom = { id: `SIM-${randomUUID()}`, reference: request.reference, state: 'open', name: options.name,
        modeId: options.modeId, mapId: options.mapId, maxPlayers: options.maxPlayers, password: options.password ?? 'DEMO', extras: options.extras };
      this.store.db.prepare('INSERT INTO simulated_room_resources(remote_id,reference,original_request,payload) VALUES(?,?,?,?)').run(room.id, request.reference, original, JSON.stringify(room));
      return room;
    });
  }
  async getRoom(remoteId: string): Promise<ProviderRoom> { return this.read(remoteId); }
  async findRoom(reference: string): Promise<ProviderRoom | undefined> {
    requireCondition(keyValid(reference), 'ROOM_REFERENCE', 'Referência inválida.');
    const row = this.store.db.prepare('SELECT payload FROM simulated_room_resources WHERE reference=?').get(reference) as Row | undefined;
    return row ? JSON.parse(row.payload) as ProviderRoom : undefined;
  }
  async updateRoom(remoteId: string, requested: RoomOptions, idempotencyKey: string): Promise<ProviderRoom> {
    const options = this.options(requested);
    return this.replay(idempotencyKey, JSON.stringify(['update', remoteId, canonical(options)]), () => {
      const room = this.read(remoteId); requireCondition(room.state === 'open', 'ROOM_REMOTE_STATE', 'A simulação só permite editar uma sala disponível.');
      return this.save({ ...room, ...options, password: options.password ?? room.password });
    });
  }
  private async finish(remoteId: string, key: string, reason: string, action: 'cancel' | 'close'): Promise<ProviderRoom> {
    requireCondition(typeof reason === 'string' && reason.trim().length >= 1 && reason.length <= 300 && !/[\u0000-\u001f\u007f]/.test(reason), 'ROOM_REASON', 'Informe um motivo de 1 a 300 caracteres.');
    return this.replay(key, JSON.stringify([action, remoteId, reason]), () => {
      const room = this.read(remoteId); const target = action === 'cancel' ? 'cancelled' : 'closed';
      requireCondition(room.state === target || room.state === 'open' || (action === 'close' && room.state === 'running'), 'ROOM_REMOTE_STATE', 'Operação incompatível com o estado atual da sala.');
      return this.save({ ...room, state: target });
    });
  }
  cancelRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom> { return this.finish(remoteId, idempotencyKey, reason, 'cancel'); }
  closeRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom> { return this.finish(remoteId, idempotencyKey, reason, 'close'); }
}
