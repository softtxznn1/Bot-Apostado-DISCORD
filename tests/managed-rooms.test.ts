import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/database.js';
import { DomainError } from '../src/domain.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { validateCatalog, validateOptions } from '../src/rooms/validation.js';
import type { ManagedRoomProvider, ProviderRoom, RoomActor, RoomCatalog, RoomOptions, RoomSettings } from '../src/rooms/types.js';

const admin: RoomActor = { userId: 'admin', administrator: true, roleIds: [] };
const owner: RoomActor = { userId: 'owner', administrator: false, roleIds: ['operator'] };
const other: RoomActor = { userId: 'other', administrator: false, roleIds: ['operator'] };
const viewer: RoomActor = { userId: 'viewer-user', administrator: false, roleIds: ['viewer'] };
const manager: RoomActor = { userId: 'manager-user', administrator: false, roleIds: ['manager'] };
const outsider: RoomActor = { userId: 'outsider', administrator: false, roleIds: [] };
const settings: RoomSettings = { guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: 'log',
  operatorRoleIds: ['operator'], managerRoleIds: ['manager'], viewerRoleIds: ['viewer'],
  allowedModeIds: [], allowedMapIds: [], maxActivePerUser: 10, maxActivePerGuild: 20, cooldownSeconds: 0 };
const catalog: RoomCatalog = { revision: 'test-v1', capabilities: { create: true, lookup: true, query: true, update: true, cancel: true, close: true },
  maps: [{ id: 'arena', label: 'Mapa simulado A' }, { id: 'desert', label: 'Mapa simulado B' }],
  modes: [{ id: 'classic', label: 'Modo simulado', mapIds: ['arena', 'desert'], minPlayers: 2, maxPlayers: 50, playerStep: 2,
    editableFields: ['name', 'modeId', 'mapId', 'maxPlayers', 'password'],
    optionFields: [{ id: 'friendly', label: 'Opção booleana', type: 'boolean', editable: true },
      { id: 'fixed', label: 'Opção imutável', type: 'integer', min: 0, max: 10, editable: false },
      { id: 'style', label: 'Escolha obrigatória', type: 'choice', required: true, editable: true, choices: [{ value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Rápido' }] }],
  }] };
const options: RoomOptions = { name: 'Sala de teste', modeId: 'classic', mapId: 'arena', maxPlayers: 10, password: 'private-password', extras: { friendly: true, fixed: 1, style: 'normal' } };
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

class Provider implements ManagedRoomProvider {
  readonly source = 'simulated' as const;
  identity = 'simulated-test-provider';
  catalog = structuredClone(catalog);
  rooms = new Map<string, ProviderRoom>();
  creates: { reference: string; options: RoomOptions; idempotencyKey: string }[] = [];
  updates = 0; cancels = 0; closes = 0; lookups = 0;
  createHandler: ((request: { reference: string; options: RoomOptions; idempotencyKey: string }) => Promise<ProviderRoom | undefined>) | undefined;
  updateHandler: (() => Promise<ProviderRoom | undefined>) | undefined;
  cancelHandler: (() => Promise<ProviderRoom | undefined>) | undefined;
  closeHandler: (() => Promise<ProviderRoom | undefined>) | undefined;
  getHandler: (() => Promise<ProviderRoom>) | undefined;
  catalogHandler: (() => Promise<RoomCatalog>) | undefined;
  async getCatalog() { return this.catalogHandler ? this.catalogHandler() : structuredClone(this.catalog); }
  async createRoom(request: { reference: string; options: RoomOptions; idempotencyKey: string }): Promise<ProviderRoom | undefined> {
    this.creates.push(structuredClone(request));
    if (this.createHandler) return this.createHandler(request);
    return this.insert(request);
  }
  insert(request: { reference: string; options: RoomOptions }): ProviderRoom {
    const room: ProviderRoom = { id: `remote-${this.rooms.size + 1}`, reference: request.reference, state: 'open', ...request.options, password: request.options.password ?? 'provider-password' };
    this.rooms.set(room.id, structuredClone(room)); return structuredClone(room);
  }
  async getRoom(id: string): Promise<ProviderRoom> {
    if (this.getHandler) return this.getHandler();
    const room = this.rooms.get(id); assert.ok(room); return structuredClone(room);
  }
  async findRoom(reference: string): Promise<ProviderRoom | undefined> {
    this.lookups++; const room = [...this.rooms.values()].find(r => r.reference === reference); return room ? structuredClone(room) : undefined;
  }
  async updateRoom(id: string, update: RoomOptions): Promise<ProviderRoom | undefined> {
    this.updates++; if (this.updateHandler) return this.updateHandler();
    const current = await this.getRoom(id); const room = { ...current, ...update, password: update.password ?? current.password };
    this.rooms.set(id, room); return room;
  }
  async cancelRoom(id: string): Promise<ProviderRoom | undefined> {
    this.cancels++; if (this.cancelHandler) return this.cancelHandler();
    const room = await this.getRoom(id); room.state = 'cancelled'; this.rooms.set(id, room); return room;
  }
  async closeRoom(id: string): Promise<ProviderRoom | undefined> {
    this.closes++; if (this.closeHandler) return this.closeHandler();
    const room = await this.getRoom(id); room.state = 'closed'; this.rooms.set(id, room); return room;
  }
}
async function setup(t: TestContext, tweaks: Partial<RoomSettings> = {}, now?: () => number) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const provider = new Provider(); const service = new ManagedRoomsService(store, provider, now);
  await service.configure({ ...settings, ...tweaks }, admin);
  return { store, provider, service };
}
async function created(service: ManagedRoomsService, actor = owner) {
  const draft = await service.createDraft('guild', actor, options); return service.create('guild', draft.id, actor);
}

test('sala é independente de partida, fila e pagamento e confirma configuração completa', async t => {
  const f = await setup(t); const room = await created(f.service);
  assert.equal(room.state, 'ready'); assert.equal(room.confirmed?.mapId, 'arena'); assert.equal(room.confirmed?.maxPlayers, 10);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM matches').get()?.n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM guilds').get()?.n, 0);
  assert.equal(f.provider.creates.length, 1);
});

test('configuração requer administração, recusa capacidades ausentes e salva catálogo permitido', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.configure(settings, owner), errorCode('FORBIDDEN'));
  await assert.rejects(f.service.configure({ ...settings, operatorRoleIds: ['guild'] }, admin), errorCode('INVALID_ROOM_SETTINGS'));
  assert.deepEqual(f.service.settings('guild')?.allowedMapIds, ['arena', 'desert']);
  f.provider.catalog.capabilities.close = false;
  await assert.rejects(f.service.configure(settings, admin), errorCode('ROOM_CAPABILITY_MISSING'));
  assert.equal(f.service.settings('guild')?.outputChannelId, 'output');
});

test('catálogo valida combinações, limites, passo, campos e escolhas extras', () => {
  validateCatalog(catalog);
  for (const invalid of [{ ...options, modeId: 'unknown' }, { ...options, mapId: 'unknown' },
    { ...options, maxPlayers: 51 }, { ...options, maxPlayers: 11 }, { ...options, extras: { friendly: 'yes', style: 'normal' } },
    { ...options, extras: { style: 'other' } }, { ...options, extras: { arbitrary: true, style: 'normal' } }, { ...options, extras: {} }]) {
    assert.throws(() => validateOptions(invalid as RoomOptions, catalog));
  }
  assert.throws(() => validateCatalog({ ...catalog, maps: [...catalog.maps, catalog.maps[0]] }));
});

test('opções e campos obrigatórios não podem ser liberados ou bloqueados incorretamente', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.configure({ ...settings, allowedModeIds: ['unknown'] }, admin), errorCode('INVALID_ROOM_SETTINGS'));
  await assert.rejects(f.service.configure({ ...settings, allowedExtraIds: ['friendly'] }, admin), errorCode('INVALID_ROOM_SETTINGS'));
  await f.service.configure({ ...settings, allowedMapIds: ['arena'], allowedExtraIds: ['style'] }, admin);
  await assert.rejects(f.service.createDraft('guild', owner, options), errorCode('ROOM_OPTION_DISABLED'));
  await assert.rejects(f.service.createDraft('guild', owner, { ...options, mapId: 'desert' }), errorCode('ROOM_OPTION_DISABLED'));
});

test('criação simultânea e botão repetido enviam somente um POST estável', async t => {
  const f = await setup(t); const draft = await f.service.createDraft('guild', owner, options);
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.provider.createHandler = async request => { await waiting; return f.provider.insert(request); };
  const first = f.service.create('guild', draft.id, owner);
  const second = f.service.create('guild', draft.id, owner);
  await Promise.resolve(); finish(); await Promise.all([first, second]);
  await f.service.create('guild', draft.id, owner);
  assert.equal(f.provider.creates.length, 1);
  assert.ok(f.provider.creates[0]?.idempotencyKey.includes(draft.id));
});

test('timeout após criar deixa pendência recuperável, sem publicar nem repetir criação', async t => {
  const f = await setup(t);
  f.provider.createHandler = async request => { f.provider.insert(request); throw new Error('sensitive vendor body'); };
  const room = await created(f.service); assert.equal(room.state, 'uncertain'); assert.equal(room.confirmed, null);
  assert.throws(() => f.service.attachPublication('guild', room.id, 'output', 'message'), errorCode('ROOM_NOT_CONFIRMED'));
  assert.equal((await f.service.create('guild', room.id, owner)).state, 'uncertain');
  await f.service.recoverPending();
  assert.equal(f.service.get('guild', room.id, owner).state, 'ready');
  assert.equal(f.provider.creates.length, 1); assert.equal(f.provider.lookups, 1);
  assert.ok(!JSON.stringify(f.service.events('guild', room.id, owner)).includes('sensitive'));
});

test('configuração divergente na resposta nunca é apresentada como sala confirmada', async t => {
  const f = await setup(t);
  f.provider.createHandler = async request => ({ ...f.provider.insert(request), maxPlayers: 20 });
  const room = await created(f.service);
  assert.equal(room.state, 'uncertain'); assert.equal(room.confirmed, null);
  assert.equal(room.lastErrorCode, 'ROOM_RESPONSE_MISMATCH');
});

test('edição respeita catálogo e atualiza sala remota antes de confirmar localmente', async t => {
  const f = await setup(t); const room = await created(f.service);
  await assert.rejects(f.service.update('guild', room.id, owner, { ...options, extras: { ...options.extras, fixed: 2 } }), errorCode('ROOM_FIELD_IMMUTABLE'));
  const updated = await f.service.update('guild', room.id, owner, { ...options, name: 'Nome atualizado', mapId: 'desert', maxPlayers: 20 });
  assert.equal(updated.state, 'ready'); assert.equal(updated.confirmed?.name, 'Nome atualizado'); assert.equal(updated.confirmed?.mapId, 'desert');
  assert.equal(f.provider.updates, 1);
});

test('edição incerta preserva estado confirmado e não é reenviada durante reconciliação', async t => {
  const f = await setup(t); const room = await created(f.service);
  f.provider.updateHandler = async () => { throw new Error('response lost'); };
  const result = await f.service.update('guild', room.id, owner, { ...options, name: 'Alterado' });
  assert.equal(result.state, 'uncertain'); assert.equal(result.confirmed?.name, options.name);
  await assert.rejects(f.service.update('guild', room.id, owner, options), errorCode('ROOM_OPERATION_PENDING'));
  const synced = await f.service.synchronize('guild', room.id, owner);
  assert.equal(synced.state, 'uncertain'); assert.equal(f.provider.updates, 1);
});

test('cancelamento e encerramento só terminam após confirmação do estado remoto', async t => {
  const f = await setup(t); const room = await created(f.service);
  f.provider.cancelHandler = async () => f.provider.getRoom(room.confirmed!.id);
  const pending = await f.service.cancel('guild', room.id, owner, 'Operador solicitou cancelamento.');
  assert.equal(pending.state, 'cancelling'); assert.ok(pending.pending);
  await assert.rejects(f.service.close('guild', room.id, owner, 'Encerrar após solicitação.'), errorCode('ROOM_OPERATION_PENDING'));
  f.provider.rooms.get(room.confirmed!.id)!.state = 'cancelled';
  assert.equal((await f.service.synchronize('guild', room.id, owner)).state, 'cancelled');
  assert.equal((await f.service.cancel('guild', room.id, owner, 'Cancelar novamente.')).state, 'cancelled');
  assert.equal(f.provider.cancels, 1);
  const next = await created(f.service); assert.equal((await f.service.close('guild', next.id, owner, 'Encerramento solicitado.')).state, 'closed');
  assert.equal(f.provider.closes, 1);
});

test('rascunho é editado/cancelado localmente, sem confundir com operação no jogo', async t => {
  const f = await setup(t); const draft = await f.service.createDraft('guild', owner, options);
  const updated = await f.service.update('guild', draft.id, owner, { ...options, name: 'Rascunho editado' });
  assert.equal(updated.state, 'draft'); assert.equal(f.provider.updates, 0);
  assert.equal((await f.service.cancel('guild', draft.id, owner, 'Desistência antes de criar.')).state, 'cancelled');
  assert.equal(f.provider.cancels, 0); assert.equal(f.provider.creates.length, 0);
});

test('cancelar rascunho funciona com fornecedor offline e libera a vaga local', async t => {
  const f = await setup(t, { maxActivePerUser: 1 });
  const draft = await f.service.createDraft('guild', owner, options);
  f.provider.catalogHandler = async () => { throw new Error('Fornecedor indisponível.'); };
  const cancelled = await f.service.cancel('guild', draft.id, owner, 'Desistência antes de enviar ao provedor.');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.pending, null); assert.equal(cancelled.confirmed, null);
  assert.equal(f.provider.cancels, 0); assert.equal(f.provider.creates.length, 0);
  f.provider.catalogHandler = undefined;
  assert.equal((await f.service.createDraft('guild', owner, options)).state, 'draft');
});

test('limites inteiros negativos documentados no catálogo são respeitados pelo domínio', async t => {
  const f = await setup(t);
  f.provider.catalog.modes[0]!.optionFields.push({ id: 'offset', label: 'Ajuste inteiro', type: 'integer', min: -10, max: 10, editable: true });
  const requested = { ...options, extras: { ...options.extras, offset: -3 } };
  const draft = await f.service.createDraft('guild', owner, requested);
  const room = await f.service.create('guild', draft.id, owner);
  assert.equal(room.state, 'ready'); assert.equal(room.confirmed?.extras.offset, -3);
  await assert.rejects(f.service.update('guild', room.id, owner, { ...requested, extras: { ...requested.extras, offset: -11 } }), errorCode('INVALID_ROOM_OPTIONS'));
});

test('reconciliação usa o último catálogo persistido mesmo se o relógio retroceder', async t => {
  let now = 1000; const f = await setup(t, {}, () => now);
  const room = await created(f.service);
  f.provider.catalog.revision = 'new-catalog';
  f.provider.catalog.modes[0]!.optionFields.push({ id: 'newRule', label: 'Nova opção', type: 'boolean', editable: true });
  now = 500;
  const updated = await f.service.update('guild', room.id, owner, { ...room.options, extras: { ...room.options.extras, newRule: true } });
  assert.equal(updated.state, 'ready'); assert.equal(updated.options.extras.newRule, true);
  const restarted = new ManagedRoomsService(f.store, f.provider, () => now);
  const synchronized = await restarted.synchronize('guild', room.id, owner);
  assert.equal(synchronized.state, 'ready'); assert.equal(synchronized.lastErrorCode, null);
  assert.equal(synchronized.options.extras.newRule, true);
});

test('cargos atuais, propriedade e isolamento entre servidores são sempre verificados', async t => {
  const f = await setup(t); const room = await created(f.service);
  assert.throws(() => f.service.get('guild', room.id, other), errorCode('FORBIDDEN'));
  assert.throws(() => f.service.get('other-guild', room.id, admin), errorCode('ROOM_NOT_FOUND'));
  assert.throws(() => f.service.get('guild', room.id, { ...owner, roleIds: [] }), errorCode('FORBIDDEN'));
  await assert.rejects(f.service.close('guild', room.id, { ...owner, roleIds: [] }, 'Sem cargo atual.'), errorCode('FORBIDDEN'));
  assert.equal(f.service.get('guild', room.id, manager).id, room.id);
  await assert.rejects(f.service.createDraft('guild', outsider, options), errorCode('FORBIDDEN'));
});

test('visualizador e histórico paginado nunca revelam senha nem operações privadas', async t => {
  const f = await setup(t); const room = await created(f.service);
  assert.throws(() => f.service.get('guild', room.id, viewer), errorCode('FORBIDDEN'));
  const result = f.service.getPublic('guild', room.id, viewer);
  assert.ok(!JSON.stringify(result).includes('private-password'));
  assert.ok(!JSON.stringify(f.service.list('guild', viewer)).includes('private-password'));
  assert.equal(f.service.list('guild', viewer).items.length, 1);
  assert.equal(f.service.list('guild', viewer, { page: 2 }).items.length, 0);
  assert.throws(() => f.service.list('guild', outsider), errorCode('FORBIDDEN'));
});

test('limites e cooldown incluem rascunhos e reservam vagas atomicamente', async t => {
  let clock = 1000; const f = await setup(t, { maxActivePerUser: 1, cooldownSeconds: 10 }, () => clock);
  const attempts = await Promise.allSettled([f.service.createDraft('guild', owner, options), f.service.createDraft('guild', owner, options)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  const room = f.service.listForReconciliation()[0]!;
  await f.service.cancel('guild', room.id, owner, 'Cancelar rascunho para testar.');
  await assert.rejects(f.service.createDraft('guild', owner, options), errorCode('ROOM_COOLDOWN'));
  clock += 10_001; assert.equal((await f.service.createDraft('guild', owner, options)).state, 'draft');
});

test('mudança do provedor bloqueia pedidos antigos e IDs remotos não são reutilizados', async t => {
  const f = await setup(t); const room = await created(f.service);
  f.provider.identity = 'different-provider';
  await assert.rejects(f.service.synchronize('guild', room.id, owner), errorCode('ROOM_PROVIDER_CHANGED'));
});

test('consulta atrasada não reabre uma sala cujo encerramento já foi confirmado', async t => {
  const f = await setup(t); const room = await created(f.service);
  const old = structuredClone(room.confirmed!);
  await f.service.close('guild', room.id, owner, 'Encerramento confirmado.');
  f.provider.getHandler = async () => old;
  const synced = await f.service.synchronize('guild', room.id, owner);
  assert.equal(synced.state, 'closed'); assert.equal(synced.confirmed?.state, 'closed');
  assert.equal(synced.lastErrorCode, 'ROOM_STATE_REGRESSION');
});

test('revisão de catálogo obrigatória não é ignorada após configuração do servidor', async t => {
  const f = await setup(t, { allowedExtraIds: ['style'] });
  f.provider.catalog.modes[0]!.optionFields.push({ id: 'newRequired', label: 'Nova opção obrigatória', type: 'boolean', required: true, editable: false });
  await assert.rejects(f.service.createDraft('guild', owner, { ...options, extras: { style: 'normal' } }), errorCode('ROOM_CATALOG_CHANGED'));
  assert.equal(f.provider.creates.length, 0);
});

test('publicação e painel não alteram revisão de domínio; eventos não registram senha', async t => {
  const f = await setup(t); const room = await created(f.service);
  const publication = f.service.attachPublication('guild', room.id, 'output', 'message');
  assert.equal(publication.version, room.version); assert.equal(publication.updatedAt, room.updatedAt);
  f.service.updatePanel('guild', 'panel', 'panel-message'); assert.equal(f.service.listSettings()[0]?.panelMessageId, 'panel-message');
  await f.service.cancel('guild', room.id, owner, `Motivo sem expor ${options.password}`);
  assert.ok(!JSON.stringify(f.service.events('guild', room.id, owner)).includes(options.password!));
  assert.throws(() => f.store.db.prepare('DELETE FROM managed_room_events').run());
});

test('banco reaberto mantém sala, pendência e histórico e recupera sem nova criação', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-room-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'room.sqlite'); let store = new Store(filename); const provider = new Provider();
  let service = new ManagedRoomsService(store, provider); await service.configure(settings, admin);
  provider.createHandler = async request => { provider.insert(request); return undefined; };
  const room = await created(service); service.updatePanel('guild', 'panel', 'saved-panel');
  store.close(); store = new Store(filename); t.after(() => store.close()); service = new ManagedRoomsService(store, provider);
  assert.equal(service.get('guild', room.id, owner).state, 'creating');
  assert.equal(service.settings('guild')?.panelMessageId, 'saved-panel');
  await service.recoverPending(); assert.equal(service.get('guild', room.id, owner).state, 'ready');
  assert.equal(provider.creates.length, 1); assert.ok(service.events('guild', room.id, owner).length >= 3);
});

for (const action of ['create', 'update', 'cancel', 'close', 'synchronize'] as const) test(`revogação durante ${action} impede retorno de dados privados após await`, async t => {
  const f = await setup(t);
  const initial = action === 'create' ? await f.service.createDraft('guild', owner, options) : await created(f.service);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const pause = async () => { started(); await hold; };
  if (action === 'create') f.provider.createHandler = async request => { await pause(); return f.provider.insert(request); };
  if (action === 'update') f.provider.updateHandler = async () => { await pause(); return { ...initial.confirmed!, name: 'Alterado' }; };
  if (action === 'cancel') f.provider.cancelHandler = async () => { await pause(); return { ...initial.confirmed!, state: 'cancelled' }; };
  if (action === 'close') f.provider.closeHandler = async () => { await pause(); return { ...initial.confirmed!, state: 'closed' }; };
  if (action === 'synchronize') f.provider.getHandler = async () => { await pause(); return initial.confirmed!; };
  const call = action === 'create' ? f.service.create('guild', initial.id, owner)
    : action === 'update' ? f.service.update('guild', initial.id, owner, { ...options, name: 'Alterado' })
      : action === 'synchronize' ? f.service.synchronize('guild', initial.id, owner)
        : f.service[action]('guild', initial.id, owner, 'Operação antes da revogação.');
  await entered;
  await f.service.configure({ ...settings, operatorRoleIds: ['replacement-operator'] }, admin);
  release();
  await assert.rejects(call, errorCode('FORBIDDEN'));
  // Finishing an already-authorized remote mutation is allowed internally, but
  // its secret response is never returned to the now-revoked caller.
  assert.ok(f.service.get('guild', initial.id, admin));
});

for (const action of ['catalog', 'createDraft'] as const) test(`revogação durante catálogo impede ${action} com autorização antiga`, async t => {
  const f = await setup(t);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  f.provider.catalogHandler = async () => { started(); await hold; return structuredClone(catalog); };
  const pending = action === 'catalog' ? f.service.catalog('guild', owner) : f.service.createDraft('guild', owner, options);
  await entered;
  const administratorService = new ManagedRoomsService(f.store, new Provider());
  await administratorService.configure({ ...settings, operatorRoleIds: ['replacement-operator'] }, admin);
  release(); await assert.rejects(pending, errorCode('FORBIDDEN'));
  assert.equal(f.service.listForReconciliation().length, 0);
});

for (const state of ['cancelled', 'closed', 'expired'] as const) test(`criação assíncrona encontrada ${state} preserva histórico e libera pendência sem anunciar disponibilidade`, async t => {
  const f = await setup(t, { maxActivePerUser: 1 });
  f.provider.createHandler = async request => { const remote = f.provider.insert(request); f.provider.rooms.get(remote.id)!.state = state; return undefined; };
  const room = await created(f.service); assert.equal(room.state, 'creating');
  await f.service.recoverPending(); const result = f.service.get('guild', room.id, owner);
  assert.equal(result.state, state); assert.equal(result.pending, null); assert.ok(result.confirmed?.id);
  const events = f.service.events('guild', room.id, owner);
  assert.ok(events.some(event => event.action === 'operation_resolved_terminal'));
  assert.ok(!events.some(event => event.action === 'create_confirmed'));
  assert.equal((await f.service.createDraft('guild', owner, options)).state, 'draft');
});

for (const action of ['cancel', 'close'] as const) test(`sala expirada durante ${action} resolve a operação com o estado efetivo`, async t => {
  const f = await setup(t); const room = await created(f.service);
  if (action === 'cancel') f.provider.cancelHandler = async () => undefined;
  else f.provider.closeHandler = async () => undefined;
  const pending = await f.service[action]('guild', room.id, owner, 'Solicitação antes de expirar.');
  assert.ok(pending.pending);
  f.provider.rooms.get(room.confirmed!.id)!.state = 'expired';
  const result = await f.service.synchronize('guild', room.id, owner);
  assert.equal(result.state, 'expired'); assert.equal(result.pending, null);
  const events = f.service.events('guild', room.id, owner);
  assert.ok(events.some(event => event.action === 'operation_resolved_terminal'));
  assert.ok(!events.some(event => event.action === `${action}_confirmed`));
});

test('defaults conhecidos do provedor são confirmados e preservados em edições posteriores', async t => {
  const f = await setup(t);
  f.provider.createHandler = async request => {
    const remote = f.provider.insert(request);
    remote.extras.fixed = 5;
    f.provider.rooms.set(remote.id, structuredClone(remote));
    return remote;
  };
  const requested = { ...options, extras: { friendly: true, style: 'normal' } };
  const draft = await f.service.createDraft('guild', owner, requested);
  const room = await f.service.create('guild', draft.id, owner);
  assert.equal(room.state, 'ready'); assert.equal(room.options.extras.fixed, 5);
  const original = f.store.db.prepare('SELECT requested_snapshot FROM managed_room_operations WHERE room_id=?').get(room.id) as { requested_snapshot: string };
  assert.ok(!JSON.parse(original.requested_snapshot).extras.fixed);
  assert.ok(!original.requested_snapshot.includes('private-password'));
  const edited = await f.service.update('guild', room.id, owner, { ...room.options, name: 'Nome atualizado' });
  assert.equal(edited.state, 'ready'); assert.equal(edited.confirmed?.extras.fixed, 5);
});

for (const invalid of ['unknown', 'wrong-type'] as const) test(`default ${invalid} na resposta nunca é aceito como opção aplicada`, async t => {
  const f = await setup(t);
  f.provider.createHandler = async request => {
    const remote = f.provider.insert(request);
    if (invalid === 'unknown') remote.extras.unrecognized = true;
    else remote.extras.fixed = 'wrong';
    return remote;
  };
  const room = await created(f.service);
  assert.equal(room.state, 'uncertain'); assert.equal(room.confirmed, null);
});
