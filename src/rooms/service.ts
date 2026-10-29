import { randomUUID } from 'node:crypto';
import { Store } from '../database.js';
import { DomainError, requireCondition } from '../domain.js';
import type {
  ManagedRoom, ManagedRoomProvider, ManagedRoomState, PendingRoomOperation, ProviderRoom,
  RoomActor, RoomCatalog, RoomOptions, RoomSettings,
} from './types.js';
import { optionsMatchRoom, validateCatalog, validateOptions, validateProviderRoom, validateSettings } from './validation.js';

export type SafeManagedRoom = Omit<ManagedRoom, 'options' | 'confirmed' | 'pending'> & {
  options: Omit<RoomOptions, 'password'>;
  confirmed: Omit<ProviderRoom, 'password'> | null;
  pending: (Omit<PendingRoomOperation, 'requestedOptions'> & { requestedOptions?: Omit<RoomOptions, 'password'> }) | null;
};
export type ManagedRoomEvent = { id: number; roomId: string; actorId: string; action: string; createdAt: number; details: Record<string, unknown> };
type Row = { payload: string };
const terminal = new Set<ManagedRoomState>(['cancelled', 'closed', 'expired', 'failed']);
const stateFromRemote = (state: ProviderRoom['state']): ManagedRoomState => state === 'open' ? 'ready' : state;
const safeErrorCode = (error: unknown) => error instanceof DomainError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'ROOM_PROVIDER_ERROR';

export function redactManagedRoom(room: ManagedRoom): SafeManagedRoom {
  const { password: _password, ...options } = room.options;
  const confirmed = room.confirmed ? (({ password: _secret, ...rest }) => rest)(room.confirmed) : null;
  const pending = room.pending ? { ...room.pending } : null;
  if (pending?.requestedOptions) {
    const { password: _pendingPassword, ...rest } = pending.requestedOptions;
    return { ...room, options, confirmed, pending: { ...pending, requestedOptions: rest } };
  }
  return { ...room, options, confirmed, pending };
}

/** Standalone room domain: no matches, player queues or financial prerequisites. */
export class ManagedRoomsService {
  constructor(readonly store: Store, readonly provider: ManagedRoomProvider, private readonly now = Date.now) {
    requireCondition(provider.identity.length > 0 && provider.identity.length <= 300, 'ROOM_PROVIDER_CONFIG', 'Identidade do provedor de salas inválida.');
    store.migrateFeature('managed_rooms', 1, `
      CREATE TABLE managed_room_settings (guild_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE managed_rooms (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES managed_room_settings(guild_id),
        creator_id TEXT NOT NULL, state TEXT NOT NULL, provider_identity TEXT NOT NULL,
        reference TEXT NOT NULL UNIQUE, remote_id TEXT, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX managed_room_remote ON managed_rooms(provider_identity,remote_id) WHERE remote_id IS NOT NULL;
      CREATE INDEX managed_room_guild ON managed_rooms(guild_id,created_at,id);
      CREATE TABLE managed_room_operations (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES managed_rooms(id), guild_id TEXT NOT NULL,
        kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
        actor_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error_code TEXT
      );
      CREATE TABLE managed_room_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES managed_rooms(id),
        guild_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
        created_at INTEGER NOT NULL, details TEXT NOT NULL
      );
      CREATE TRIGGER managed_room_events_no_update BEFORE UPDATE ON managed_room_events BEGIN SELECT RAISE(ABORT,'room events are append-only'); END;
      CREATE TRIGGER managed_room_events_no_delete BEFORE DELETE ON managed_room_events BEGIN SELECT RAISE(ABORT,'room events are append-only'); END;
    `, 2);
    store.migrateFeature('managed_rooms', 2, `
      ALTER TABLE managed_room_operations ADD COLUMN catalog_snapshot TEXT;
      ALTER TABLE managed_room_operations ADD COLUMN requested_snapshot TEXT;
    `);
  }

  private atomic<T>(fn: () => T): T { return this.store.db.isTransaction ? fn() : this.store.transaction(fn); }
  private manager(settings: RoomSettings, actor: RoomActor): boolean {
    return actor.administrator || settings.managerRoleIds.some(role => actor.roleIds.includes(role));
  }
  private operator(settings: RoomSettings, actor: RoomActor): boolean {
    return this.manager(settings, actor) || settings.operatorRoleIds.some(role => actor.roleIds.includes(role));
  }
  private allowed(settings: RoomSettings, actor: RoomActor): boolean {
    return this.operator(settings, actor) || settings.viewerRoleIds.some(role => actor.roleIds.includes(role));
  }
  private auth(room: ManagedRoom, actor: RoomActor, write = false): void {
    const settings = this.requiredSettings(room.guildId);
    requireCondition(this.manager(settings, actor) || (this.operator(settings, actor) && room.creatorId === actor.userId)
      || (!write && !!room.confirmed && settings.viewerRoleIds.some(role => actor.roleIds.includes(role))), 'FORBIDDEN', 'Você não tem permissão para acessar esta sala.');
  }
  private sameProvider(room: ManagedRoom): void {
    requireCondition(room.providerIdentity === this.provider.identity && room.source === this.provider.source, 'ROOM_PROVIDER_CHANGED', 'Recupere o vínculo original do provedor antes de consultar ou alterar esta sala.');
  }
  settings(guildId: string): RoomSettings | undefined {
    const row = this.store.db.prepare('SELECT payload FROM managed_room_settings WHERE guild_id=?').get(guildId) as Row | undefined;
    return row ? JSON.parse(row.payload) as RoomSettings : undefined;
  }
  private requiredSettings(guildId: string): RoomSettings {
    const settings = this.settings(guildId);
    requireCondition(settings, 'ROOMS_NOT_CONFIGURED', 'Configure canais, cargos e opções com /salas configurar.');
    return settings;
  }
  async availableCatalog(actor: RoomActor): Promise<RoomCatalog> {
    requireCondition(actor.administrator, 'FORBIDDEN', 'Somente a administração pode configurar o catálogo inicial.');
    return validateCatalog(await this.provider.getCatalog());
  }
  async configure(input: RoomSettings, actor: RoomActor): Promise<RoomSettings> {
    requireCondition(actor.administrator, 'FORBIDDEN', 'Somente a administração pode configurar as salas.');
    const catalog = await this.availableCatalog(actor);
    requireCondition(Object.values(catalog.capabilities).every(Boolean), 'ROOM_CAPABILITY_MISSING', 'O provedor precisa oferecer criação, consulta, recuperação, edição, cancelamento e encerramento.');
    const settings = validateSettings({ ...input,
      allowedModeIds: input.allowedModeIds.length ? input.allowedModeIds : catalog.modes.map(m => m.id),
      allowedMapIds: input.allowedMapIds.length ? input.allowedMapIds : catalog.maps.map(m => m.id),
    });
    requireCondition(settings.allowedModeIds.every(id => catalog.modes.some(m => m.id === id))
      && settings.allowedMapIds.every(id => catalog.maps.some(m => m.id === id)), 'INVALID_ROOM_SETTINGS', 'Modo ou mapa configurado não pertence ao catálogo do provedor.');
    for (const mode of catalog.modes.filter(m => settings.allowedModeIds.includes(m.id))) {
      requireCondition(mode.mapIds.some(id => settings.allowedMapIds.includes(id)), 'INVALID_ROOM_SETTINGS', 'Cada modo liberado precisa ter ao menos um mapa permitido.');
      for (const field of mode.optionFields) requireCondition(!field.required || !settings.allowedExtraIds || settings.allowedExtraIds.includes(field.id), 'INVALID_ROOM_SETTINGS', 'Não desabilite uma opção obrigatória de um modo permitido.');
    }
    if (settings.allowedExtraIds) requireCondition(settings.allowedExtraIds.every(id => catalog.modes.some(mode => mode.optionFields.some(field => field.id === id))), 'INVALID_ROOM_SETTINGS', 'Opção adicional inexistente no catálogo.');
    this.atomic(() => {
      this.store.db.prepare('INSERT INTO managed_room_settings(guild_id,payload) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET payload=excluded.payload').run(settings.guildId, JSON.stringify(settings));
    });
    return settings;
  }
  private async fullCatalog(guildId: string, actor: RoomActor, checkRequiredFields = true): Promise<RoomCatalog> {
    requireCondition(this.allowed(this.requiredSettings(guildId), actor), 'FORBIDDEN', 'Seu cargo não tem acesso ao catálogo de salas.');
    const full = validateCatalog(await this.provider.getCatalog());
    const settings = this.requiredSettings(guildId);
    requireCondition(this.allowed(settings, actor), 'FORBIDDEN', 'Seu cargo não tem mais acesso ao catálogo de salas.');
    for (const mode of full.modes.filter(m => checkRequiredFields && settings.allowedModeIds.includes(m.id))) for (const field of mode.optionFields) {
      requireCondition(!field.required || !settings.allowedExtraIds || settings.allowedExtraIds.includes(field.id), 'ROOM_CATALOG_CHANGED', 'O provedor passou a exigir uma opção desabilitada. A administração deve revisar o catálogo.');
    }
    return full;
  }
  async catalog(guildId: string, actor: RoomActor): Promise<RoomCatalog> {
    const full = await this.fullCatalog(guildId, actor);
    const settings = this.requiredSettings(guildId);
    return { ...full,
      modes: full.modes.filter(mode => settings.allowedModeIds.includes(mode.id)).map(mode => ({ ...mode,
        mapIds: mode.mapIds.filter(mapId => settings.allowedMapIds.includes(mapId)),
        optionFields: mode.optionFields.filter(field => !settings.allowedExtraIds || settings.allowedExtraIds.includes(field.id)),
      })).filter(mode => mode.mapIds.length > 0),
      maps: full.maps.filter(map => settings.allowedMapIds.includes(map.id)),
    };
  }
  private raw(guildId: string, id: string): ManagedRoom {
    const row = this.store.db.prepare('SELECT payload FROM managed_rooms WHERE guild_id=? AND id=?').get(guildId, id) as Row | undefined;
    requireCondition(row, 'ROOM_NOT_FOUND', 'Sala não encontrada neste servidor.');
    return JSON.parse(row.payload) as ManagedRoom;
  }
  private save(room: ManagedRoom): ManagedRoom {
    room.updatedAt = this.now(); room.version++;
    this.store.db.prepare('UPDATE managed_rooms SET state=?,remote_id=?,payload=?,updated_at=? WHERE id=? AND guild_id=?')
      .run(room.state, room.confirmed?.id ?? null, JSON.stringify(room), room.updatedAt, room.id, room.guildId);
    return room;
  }
  private event(room: ManagedRoom, actorId: string, action: string, details: Record<string, unknown> = {}): void {
    this.store.db.prepare('INSERT INTO managed_room_events(room_id,guild_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
      .run(room.id, room.guildId, actorId, action, this.now(), JSON.stringify(details));
  }
  private reason(value: string, room: ManagedRoom): string {
    requireCondition(typeof value === 'string' && value.trim().length >= 3 && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value), 'INVALID_ROOM_REASON', 'Informe um motivo de 3 a 300 caracteres, sem controles.');
    let reason = value.trim();
    for (const secret of [room.options.password, room.confirmed?.password]) if (secret) reason = reason.split(secret).join('[REDACTED]');
    return reason;
  }
  get(guildId: string, id: string, actor: RoomActor): ManagedRoom {
    const room = this.raw(guildId, id); this.auth(room, actor, true); return room;
  }
  getPublic(guildId: string, id: string, actor: RoomActor): SafeManagedRoom {
    const room = this.raw(guildId, id); this.auth(room, actor); return redactManagedRoom(room);
  }
  list(guildId: string, actor: RoomActor, options: { page?: number; state?: ManagedRoomState; creatorId?: string } = {}): { items: SafeManagedRoom[]; page: number; total: number; pageSize: number } {
    const settings = this.requiredSettings(guildId);
    requireCondition(this.allowed(settings, actor), 'FORBIDDEN', 'Você não tem acesso às salas deste servidor.');
    const page = options.page ?? 1;
    requireCondition(Number.isInteger(page) && page >= 1 && page <= 100_000, 'INVALID_ROOM_PAGE', 'Página inválida.');
    const rows = (this.store.db.prepare('SELECT payload FROM managed_rooms WHERE guild_id=? ORDER BY created_at DESC,id').all(guildId) as Row[]).map(row => JSON.parse(row.payload) as ManagedRoom)
      .filter(room => this.manager(settings, actor) || (this.operator(settings, actor) && room.creatorId === actor.userId) || (!!room.confirmed && settings.viewerRoleIds.some(role => actor.roleIds.includes(role))))
      .filter(room => (!options.state || room.state === options.state) && (!options.creatorId || room.creatorId === options.creatorId));
    const pageSize = 10;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize).map(redactManagedRoom), total: rows.length, page, pageSize };
  }
  async createDraft(guildId: string, actor: RoomActor, input: RoomOptions): Promise<ManagedRoom> {
    const settings = this.requiredSettings(guildId);
    requireCondition(this.operator(settings, actor), 'FORBIDDEN', 'É necessário cargo de operador de salas.');
    const catalog = await this.fullCatalog(guildId, actor);
    requireCondition(catalog.capabilities.create, 'ROOM_CAPABILITY_MISSING', 'O provedor não suporta criação de salas.');
    validateOptions(input, catalog, this.requiredSettings(guildId));
    return this.atomic(() => {
      const fresh = this.requiredSettings(guildId); requireCondition(this.operator(fresh, actor), 'FORBIDDEN', 'Seu cargo não pode criar salas.');
      const options = validateOptions(input, catalog, fresh);
      const active = this.listForReconciliation().filter(room => room.guildId === guildId && !terminal.has(room.state));
      requireCondition(active.length < fresh.maxActivePerGuild && active.filter(room => room.creatorId === actor.userId).length < fresh.maxActivePerUser, 'ROOM_LIMIT', 'Limite de salas ativas atingido. Encerre ou cancele uma sala antes de criar outra.');
      const last = this.store.db.prepare('SELECT MAX(created_at) AS last FROM managed_rooms WHERE guild_id=? AND creator_id=?').get(guildId, actor.userId) as { last: number | null };
      requireCondition(last.last === null || this.now() >= last.last + fresh.cooldownSeconds * 1000, 'ROOM_COOLDOWN', 'Aguarde o intervalo de criação configurado neste servidor.');
      const id = randomUUID(); const now = this.now();
      const room: ManagedRoom = { id, guildId, creatorId: actor.userId, providerIdentity: this.provider.identity,
        source: this.provider.source, reference: id, state: 'draft', options, confirmed: null, pending: null,
        createdAt: now, updatedAt: now, lastSyncedAt: null, lastErrorCode: null, version: 1,
        publicationChannelId: null, publicationMessageId: null };
      this.store.db.prepare('INSERT INTO managed_rooms(id,guild_id,creator_id,state,provider_identity,reference,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, guildId, actor.userId, room.state, room.providerIdentity, room.reference, JSON.stringify(room), now, now);
      this.event(room, actor.userId, 'draft_created'); return room;
    });
  }
  private begin(room: ManagedRoom, actor: RoomActor, kind: PendingRoomOperation['kind'], catalog: RoomCatalog, options?: RoomOptions, reason?: string): ManagedRoom {
    const id = randomUUID();
    room.pending = { id, kind, idempotencyKey: `room:${room.id}:${id}`, startedAt: this.now(), ...(options ? { requestedOptions: options } : {}), ...(reason ? { reason } : {}) };
    room.state = ({ create: 'creating', update: 'updating', cancel: 'cancelling', close: 'closing' } as const)[kind]; room.lastErrorCode = null;
    const requestedSnapshot = options ? (({ password: _secret, ...rest }) => rest)(options) : null;
    this.store.db.prepare('INSERT INTO managed_room_operations(id,room_id,guild_id,kind,idempotency_key,state,actor_id,started_at,catalog_snapshot,requested_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, room.id, room.guildId, kind, room.pending.idempotencyKey, 'pending', actor.userId, this.now(), JSON.stringify(catalog), requestedSnapshot ? JSON.stringify(requestedSnapshot) : null);
    this.event(room, actor.userId, `${kind}_requested`, { operationId: id, ...(reason ? { reason } : {}) });
    return this.save(room);
  }
  private uncertain(guildId: string, id: string, opId: string, error: unknown): ManagedRoom {
    return this.atomic(() => {
      const room = this.raw(guildId, id); if (room.pending?.id !== opId) return room;
      room.state = 'uncertain'; room.lastErrorCode = safeErrorCode(error);
      this.store.db.prepare('UPDATE managed_room_operations SET error_code=? WHERE id=?').run(room.lastErrorCode, opId);
      this.event(room, 'system', 'operation_uncertain', { operationId: opId, code: room.lastErrorCode }); return this.save(room);
    });
  }
  private storedCatalog(room: ManagedRoom): RoomCatalog | undefined {
    const row = room.pending
      ? this.store.db.prepare('SELECT catalog_snapshot FROM managed_room_operations WHERE room_id=? AND id=?').get(room.id, room.pending.id)
      // Operations for one room are claimed serially. Their persisted insertion
      // order stays reliable when timestamps tie or the system clock moves back.
      : this.store.db.prepare('SELECT catalog_snapshot FROM managed_room_operations WHERE room_id=? AND catalog_snapshot IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(room.id);
    const snapshot = (row as { catalog_snapshot?: string | null } | undefined)?.catalog_snapshot;
    return snapshot ? validateCatalog(JSON.parse(snapshot)) : undefined;
  }
  private appliedOptions(remote: ProviderRoom): RoomOptions {
    return { name: remote.name, modeId: remote.modeId, mapId: remote.mapId, maxPlayers: remote.maxPlayers,
      ...(remote.password === null ? {} : { password: remote.password }), extras: structuredClone(remote.extras) };
  }
  private apply(guildId: string, id: string, response: ProviderRoom, expectedOp: string | null, expectedVersion?: number, knownCatalog?: RoomCatalog): ManagedRoom {
    return this.atomic(() => {
      const room = this.raw(guildId, id); this.sameProvider(room);
      if ((room.pending?.id ?? null) !== expectedOp || (expectedOp === null && expectedVersion !== undefined && room.version !== expectedVersion)) return room;
      const remote = validateProviderRoom(response);
      const catalog = knownCatalog ?? this.storedCatalog(room);
      requireCondition(catalog, 'ROOM_CATALOG_REQUIRED', 'A operação precisa de um catálogo verificado para confirmar a resposta.');
      // Defaults may be supplied by the provider, but every field must still
      // belong to the captured catalog and satisfy its documented type/limits.
      const appliedOptions = validateOptions(this.appliedOptions(remote), catalog);
      requireCondition(remote.reference === room.reference && (!room.confirmed || remote.id === room.confirmed.id), 'ROOM_RESPONSE_MISMATCH', 'A resposta do provedor não corresponde à sala solicitada.');
      requireCondition(!room.confirmed || !['cancelled', 'closed', 'expired'].includes(room.confirmed.state)
        || remote.state === room.confirmed.state, 'ROOM_STATE_REGRESSION', 'A consulta tentou reverter um estado terminal já confirmado. Revise o provedor antes de prosseguir.');
      const reused = this.store.db.prepare('SELECT id FROM managed_rooms WHERE provider_identity=? AND remote_id=? AND id!=?').get(room.providerIdentity, remote.id, room.id);
      requireCondition(!reused, 'ROOM_RESPONSE_MISMATCH', 'O provedor retornou uma sala já associada a outra solicitação.');
      const pending = room.pending;
      const requested = pending?.requestedOptions ?? room.options;
      const matches = optionsMatchRoom(requested, remote);
      const remoteTerminal = ['cancelled', 'closed', 'expired'].includes(remote.state);
      const requestedTerminal = (pending?.kind === 'cancel' && remote.state === 'cancelled') || (pending?.kind === 'close' && remote.state === 'closed');
      if (pending && remoteTerminal && !requestedTerminal) {
        // A real room can expire or be ended externally before an asynchronous
        // operation is observed. Record its actual terminal state without
        // claiming that creation/edit/cancellation itself was successful.
        this.store.db.prepare("UPDATE managed_room_operations SET state='resolved_terminal',finished_at=?,error_code=NULL WHERE id=?").run(this.now(), pending.id);
        this.event(room, 'system', 'operation_resolved_terminal', {
          operationId: pending.id, kind: pending.kind, remoteState: remote.state, requestedOptionsMatched: matches,
        });
        room.confirmed = remote; room.pending = null; room.state = stateFromRemote(remote.state);
        room.lastSyncedAt = this.now(); room.lastErrorCode = null; return this.save(room);
      }
      if (pending?.kind === 'create' || pending?.kind === 'update') {
        requireCondition(matches, 'ROOM_RESPONSE_MISMATCH', 'A configuração confirmada não corresponde à configuração solicitada.');
        if (pending.kind === 'create') requireCondition(remote.state === 'open' || remote.state === 'running', 'ROOM_RESPONSE_MISMATCH', 'O provedor não confirmou uma sala disponível.');
      }
      const done = !pending || ((pending.kind === 'create' || pending.kind === 'update') && matches)
        || (pending.kind === 'cancel' && remote.state === 'cancelled') || (pending.kind === 'close' && remote.state === 'closed');
      if (!done) {
        room.lastSyncedAt = this.now(); room.lastErrorCode = 'ROOM_OPERATION_PENDING';
        return this.save(room);
      }
      if (pending) {
        room.options = appliedOptions;
        this.store.db.prepare("UPDATE managed_room_operations SET state='confirmed',finished_at=?,error_code=NULL WHERE id=?").run(this.now(), pending.id);
        this.event(room, 'system', `${pending.kind}_confirmed`, { operationId: pending.id, remoteState: remote.state });
      } else { room.options = appliedOptions; this.event(room, 'system', 'room_synchronized', { remoteState: remote.state }); }
      room.confirmed = remote; room.pending = null; room.state = stateFromRemote(remote.state);
      room.lastSyncedAt = this.now(); room.lastErrorCode = null; return this.save(room);
    });
  }
  private async execute(room: ManagedRoom): Promise<ManagedRoom> {
    const op = room.pending!;
    try {
      let result: ProviderRoom | undefined;
      if (op.kind === 'create') result = await this.provider.createRoom({ reference: room.reference, options: op.requestedOptions!, idempotencyKey: op.idempotencyKey });
      else if (op.kind === 'update') result = await this.provider.updateRoom(room.confirmed!.id, op.requestedOptions!, op.idempotencyKey);
      else if (op.kind === 'cancel') result = await this.provider.cancelRoom(room.confirmed!.id, op.idempotencyKey, op.reason!);
      else result = await this.provider.closeRoom(room.confirmed!.id, op.idempotencyKey, op.reason!);
      if (!result) return this.raw(room.guildId, room.id);
      return this.apply(room.guildId, room.id, result, op.id);
    } catch (error) { return this.uncertain(room.guildId, room.id, op.id, error); }
  }
  async create(guildId: string, id: string, actor: RoomActor): Promise<ManagedRoom> {
    const first = this.get(guildId, id, actor); this.sameProvider(first);
    if (first.state !== 'draft') return first;
    const catalog = await this.fullCatalog(guildId, actor);
    const room = this.atomic(() => {
      const current = this.get(guildId, id, actor); this.sameProvider(current);
      if (current.state !== 'draft') return current;
      requireCondition(catalog.capabilities.create, 'ROOM_CAPABILITY_MISSING', 'O provedor não permite criar salas.');
      const options = validateOptions(current.options, catalog, this.requiredSettings(guildId));
      return this.begin(current, actor, 'create', catalog, options);
    });
    // Only the call that claimed the draft sends HTTP. Concurrent create() calls
    // observe the same pending operation but cannot acquire the draft again.
    if (room.state !== 'creating' || !room.pending) return room;
    const op = room.pending.id;
    const sent = this.atomic(() => this.store.db.prepare("UPDATE managed_room_operations SET state='sent' WHERE id=? AND state='pending'").run(op).changes);
    if (!sent) return this.raw(guildId, id);
    await this.execute(room);
    return this.get(guildId, id, actor);
  }
  async update(guildId: string, id: string, actor: RoomActor, input: RoomOptions): Promise<ManagedRoom> {
    const first = this.get(guildId, id, actor); this.sameProvider(first);
    const catalog = await this.fullCatalog(guildId, actor);
    const room = this.atomic(() => {
      const current = this.get(guildId, id, actor); this.sameProvider(current);
      const freshSettings = this.requiredSettings(guildId);
      requireCondition(!current.pending, 'ROOM_OPERATION_PENDING', 'Há uma operação pendente; consulte antes de alterar novamente.');
      if (current.state === 'draft') {
        current.options = validateOptions(input, catalog, freshSettings);
        this.event(current, actor.userId, 'draft_updated'); return this.save(current);
      }
      requireCondition(current.state === 'ready' && current.confirmed, 'ROOM_INVALID_STATE', 'Esta sala não permite edição neste estado.');
      requireCondition(catalog.capabilities.update, 'ROOM_CAPABILITY_MISSING', 'O provedor não suporta edição.');
      const mode = catalog.modes.find(m => m.id === current.options.modeId);
      requireCondition(mode, 'ROOM_CATALOG_CHANGED', 'O modo da sala não está mais disponível no catálogo.');
      requireCondition(input && typeof input === 'object' && input.extras && typeof input.extras === 'object'
        && !Array.isArray(input.extras) && [Object.prototype, null].includes(Object.getPrototypeOf(input.extras)), 'INVALID_ROOM_OPTIONS', 'Opções adicionais inválidas.');
      const supplied = { ...input.extras }; const retained: RoomOptions['extras'] = {};
      if (input.modeId === current.options.modeId) for (const [key, value] of Object.entries(current.options.extras)) {
        const definition = mode.optionFields.find(field => field.id === key);
        const disabled = !!freshSettings.allowedExtraIds && !freshSettings.allowedExtraIds.includes(key);
        if (definition && (definition.editable !== true || disabled)) {
          requireCondition(!Object.hasOwn(supplied, key) || supplied[key] === value, disabled ? 'ROOM_OPTION_DISABLED' : 'ROOM_FIELD_IMMUTABLE', 'Uma opção aplicada pelo provedor não pode ser alterada nesta configuração.');
          retained[key] = value;
          if (disabled) delete supplied[key]; else supplied[key] = value;
        }
      }
      const candidate = { ...input, password: input.password ?? current.options.password, extras: supplied };
      const validated = validateOptions(candidate, catalog, freshSettings);
      const options = validateOptions({ ...validated, extras: { ...retained, ...validated.extras } }, catalog);
      for (const key of ['name', 'modeId', 'mapId', 'maxPlayers', 'password'] as const) requireCondition(current.options[key] === options[key] || mode.editableFields.includes(key), 'ROOM_FIELD_IMMUTABLE', 'A API não permite alterar um dos campos solicitados.');
      for (const key of new Set(input.modeId === current.options.modeId ? [...Object.keys(current.options.extras), ...Object.keys(options.extras)] : [])) {
        if (current.options.extras[key] !== options.extras[key]) requireCondition(mode.optionFields.find(field => field.id === key)?.editable === true, 'ROOM_FIELD_IMMUTABLE', 'A API não permite alterar uma das opções adicionais.');
      }
      return this.begin(current, actor, 'update', catalog, options);
    });
    if (room.pending) await this.execute(room);
    return this.get(guildId, id, actor);
  }
  private async end(guildId: string, id: string, actor: RoomActor, kind: 'cancel' | 'close', reason: string): Promise<ManagedRoom> {
    const first = this.get(guildId, id, actor); this.sameProvider(first); const why = this.reason(reason, first);
    if (first.state === (kind === 'cancel' ? 'cancelled' : 'closed')) return first;
    if (kind === 'cancel' && first.state === 'draft') return this.atomic(() => {
      // A draft has no remote resource: releasing its reserved slot must not
      // depend on an available supplier or a fresh remote catalog.
      const current = this.get(guildId, id, actor); this.sameProvider(current);
      requireCondition(current.state === 'draft' && !current.pending, 'ROOM_INVALID_STATE', 'O rascunho não está disponível para cancelamento local.');
      current.state = 'cancelled'; this.event(current, actor.userId, 'draft_cancelled', { reason: why }); return this.save(current);
    });
    const catalog = await this.fullCatalog(guildId, actor, false);
    const room = this.atomic(() => {
      const current = this.get(guildId, id, actor); this.sameProvider(current);
      requireCondition(!current.pending, 'ROOM_OPERATION_PENDING', 'Aguarde a confirmação da operação pendente antes de solicitar outra.');
      requireCondition(current.confirmed && (kind === 'cancel' ? current.state === 'ready' : current.state === 'ready' || current.state === 'running'), 'ROOM_INVALID_STATE', 'Esta ação não está disponível para o estado confirmado da sala.');
      requireCondition(catalog.capabilities[kind], 'ROOM_CAPABILITY_MISSING', 'O provedor não oferece esta operação.');
      return this.begin(current, actor, kind, catalog, undefined, why);
    });
    if (room.pending) await this.execute(room);
    return this.get(guildId, id, actor);
  }
  cancel(guildId: string, id: string, actor: RoomActor, reason: string): Promise<ManagedRoom> { return this.end(guildId, id, actor, 'cancel', reason); }
  close(guildId: string, id: string, actor: RoomActor, reason: string): Promise<ManagedRoom> { return this.end(guildId, id, actor, 'close', reason); }

  private async synchronizeInternal(guildId: string, id: string): Promise<ManagedRoom> {
    const room = this.raw(guildId, id); this.sameProvider(room);
    if (room.state === 'draft' || (terminal.has(room.state) && !room.confirmed)) return room;
    try {
      let catalog = this.storedCatalog(room);
      if (!catalog) {
        catalog = validateCatalog(await this.provider.getCatalog());
        if (room.pending) this.atomic(() => {
          const current = this.raw(guildId, id);
          if (current.pending?.id === room.pending!.id) this.store.db.prepare('UPDATE managed_room_operations SET catalog_snapshot=? WHERE id=? AND catalog_snapshot IS NULL').run(JSON.stringify(catalog), room.pending!.id);
        });
      }
      const response = room.pending?.kind === 'create' || !room.confirmed
        ? await this.provider.findRoom(room.reference) : await this.provider.getRoom(room.confirmed.id);
      if (!response) return room;
      return this.apply(guildId, id, response, room.pending?.id ?? null, room.version, catalog);
    } catch (error) {
      if (room.pending) return this.uncertain(guildId, id, room.pending.id, error);
      return this.atomic(() => {
        const current = this.raw(guildId, id);
        if (current.version !== room.version) return current;
        current.lastErrorCode = safeErrorCode(error); this.event(current, 'system', 'synchronization_failed', { code: current.lastErrorCode }); return this.save(current);
      });
    }
  }
  async synchronize(guildId: string, id: string, actor: RoomActor): Promise<ManagedRoom> {
    this.get(guildId, id, actor);
    await this.synchronizeInternal(guildId, id);
    return this.get(guildId, id, actor);
  }
  synchronizeForDelivery(guildId: string, id: string): Promise<ManagedRoom> { return this.synchronizeInternal(guildId, id); }
  listForReconciliation(): ManagedRoom[] {
    return (this.store.db.prepare('SELECT payload FROM managed_rooms ORDER BY updated_at,id').all() as Row[]).map(row => JSON.parse(row.payload) as ManagedRoom);
  }
  listSettings(): RoomSettings[] {
    return (this.store.db.prepare('SELECT payload FROM managed_room_settings ORDER BY guild_id').all() as Row[]).map(row => JSON.parse(row.payload) as RoomSettings);
  }
  getForDelivery(guildId: string, id: string): ManagedRoom { return this.raw(guildId, id); }
  async recoverPending(): Promise<ManagedRoom[]> {
    const recovered: ManagedRoom[] = [];
    for (const room of this.listForReconciliation().filter(r => r.pending)) recovered.push(await this.synchronizeInternal(room.guildId, room.id));
    return recovered;
  }
  attachPublication(guildId: string, id: string, channelId: string, messageId: string): ManagedRoom {
    return this.atomic(() => {
      const room = this.raw(guildId, id);
      requireCondition(room.confirmed, 'ROOM_NOT_CONFIRMED', 'Não publique os dados antes de confirmar a criação da sala.');
      room.publicationChannelId = channelId; room.publicationMessageId = messageId;
      this.store.db.prepare('UPDATE managed_rooms SET payload=? WHERE guild_id=? AND id=?').run(JSON.stringify(room), guildId, id);
      return room;
    });
  }
  updatePanel(guildId: string, channelId: string, messageId: string): void {
    this.atomic(() => {
      const settings = this.requiredSettings(guildId);
      requireCondition(settings.panelChannelId === channelId, 'ROOM_CHANNEL_CHANGED', 'O canal do painel foi alterado.');
      settings.panelMessageId = messageId;
      this.store.db.prepare('UPDATE managed_room_settings SET payload=? WHERE guild_id=?').run(JSON.stringify(settings), guildId);
    });
  }
  events(guildId: string, id: string, actor: RoomActor): ManagedRoomEvent[] {
    const room = this.raw(guildId, id); this.auth(room, actor);
    return (this.store.db.prepare('SELECT * FROM managed_room_events WHERE guild_id=? AND room_id=? ORDER BY id LIMIT 200').all(guildId, id) as { id: number; room_id: string; actor_id: string; action: string; created_at: number; details: string }[])
      .map(row => ({ id: row.id, roomId: row.room_id, actorId: row.actor_id, action: row.action, createdAt: row.created_at, details: JSON.parse(row.details) as Record<string, unknown> }));
  }
}
