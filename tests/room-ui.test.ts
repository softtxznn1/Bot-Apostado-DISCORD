import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, type Interaction } from 'discord.js';
import { Store } from '../src/database.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { RoomInteractions } from '../src/rooms/interactions.js';
import { roomCommands } from '../src/rooms/commands.js';
import { DurableOutbox } from '../src/outbox.js';
import { roomEmbed, roomPanel } from '../src/rooms/presentation.js';
import type { ManagedRoom, ManagedRoomProvider, ProviderRoom, RoomCatalog, RoomOptions, RoomOptionField } from '../src/rooms/types.js';

type User = { id: string; roles: string[]; admin?: boolean };
type UIComponent = { custom_id?: string; label?: string; options?: { label: string; value: string }[]; components?: UIComponent[] };
type UIMessage = { content?: string; components?: UIComponent[]; embeds?: unknown[] };
class FakeInteraction {
  deferred = false; replied = false; readonly replies: unknown[] = [];
  modal: { custom_id: string; components: UIComponent[] } | undefined;
  user: { id: string }; member: { roles: { cache: Collection<string, object> } };
  memberPermissions: { has: () => boolean };
  guild: { members: { fetch: (input: { user: string; force: boolean }) => Promise<unknown> } };
  values: string[];
  fields: { getTextInputValue: (name: string) => string };
  options: {
    getSubcommand: () => string; getString: (name: string) => string | null;
    getInteger: (name: string) => number | null; getUser: (name: string) => { id: string } | null;
    getRole: (name: string) => { id: string } | null; getChannel: (name: string) => { id: string } | null;
  };
  constructor(readonly kind: 'button' | 'select' | 'modal' | 'command', readonly customId: string,
    readonly guildId: string, actor: User, users: Map<string, User>, data: Record<string, string | number> = {}, values: string[] = [], readonly commandName = '') {
    this.user = { id: actor.id }; this.member = { roles: { cache: new Collection(actor.roles.map(id => [id, {}])) } };
    this.memberPermissions = { has: () => !!actor.admin };
    this.guild = { members: { fetch: async ({ user }) => {
      const actual = users.get(user)!;
      return { id: actual.id, roles: { cache: new Collection(actual.roles.map(id => [id, {}])) }, permissions: { has: () => !!actual.admin } };
    } } };
    this.values = values; this.fields = { getTextInputValue: name => String(data[name] ?? '') };
    this.options = {
      getSubcommand: () => String(data.sub ?? ''), getString: name => data[name] === undefined ? null : String(data[name]),
      getInteger: name => data[name] === undefined ? null : Number(data[name]),
      getUser: name => data[name] === undefined ? null : { id: String(data[name]) },
      getRole: name => data[name] === undefined ? null : { id: String(data[name]) },
      getChannel: name => data[name] === undefined ? null : { id: String(data[name]) },
    };
  }
  inCachedGuild() { return true; }
  isChatInputCommand() { return this.kind === 'command'; }
  isButton() { return this.kind === 'button'; }
  isStringSelectMenu() { return this.kind === 'select'; }
  isModalSubmit() { return this.kind === 'modal'; }
  async deferReply(options: unknown) { this.deferred = true; this.replies.push({ defer: options }); }
  async deferUpdate() { this.deferred = true; }
  async reply(payload: unknown) { this.replied = true; this.replies.push(payload); }
  async editReply(payload: unknown) { this.replies.push(payload); }
  async showModal(modal: { toJSON(): unknown }) { this.replied = true; this.modal = JSON.parse(JSON.stringify(modal.toJSON())); }
  message(): UIMessage {
    const last = this.replies.at(-1);
    return typeof last === 'string' ? { content: last } : JSON.parse(JSON.stringify(last)) as UIMessage;
  }
}
class Provider implements ManagedRoomProvider {
  identity = 'UI-test-provider'; readonly source = 'simulated' as const;
  creates = 0; cancels = 0; closes = 0; updates = 0; pendingCreate = false;
  onCreate: (() => void) | undefined;
  readonly rooms = new Map<string, ProviderRoom>();
  constructor(readonly catalog: RoomCatalog) {}
  async getCatalog() { return structuredClone(this.catalog); }
  async createRoom(request: { reference: string; options: RoomOptions; idempotencyKey: string }) {
    this.creates++; this.onCreate?.(); if (this.pendingCreate) return undefined;
    const room: ProviderRoom = { ...structuredClone(request.options), id: `remote-${this.creates}`, reference: request.reference, state: 'open', password: request.options.password ?? 'provider-password' };
    this.rooms.set(room.id, room); return structuredClone(room);
  }
  async getRoom(id: string) { return structuredClone(this.rooms.get(id)!); }
  async findRoom(reference: string) { return structuredClone([...this.rooms.values()].find(r => r.reference === reference)); }
  async updateRoom(id: string, options: RoomOptions) { this.updates++; const room = this.rooms.get(id)!; Object.assign(room, structuredClone(options)); return structuredClone(room); }
  async cancelRoom(id: string) { this.cancels++; this.rooms.get(id)!.state = 'cancelled'; return this.getRoom(id); }
  async closeRoom(id: string) { this.closes++; this.rooms.get(id)!.state = 'closed'; return this.getRoom(id); }
}
async function setup(t: TestContext, opts: { modes?: number; maps?: number; extras?: RoomOptionField[] } = {}) {
  const users = new Map<string, User>([['owner', { id: 'owner', roles: ['operator'] }], ['other', { id: 'other', roles: ['operator'] }], ['viewer', { id: 'viewer', roles: ['viewer'] }], ['admin', { id: 'admin', roles: [], admin: true }]]);
  const maps = Array.from({ length: opts.maps ?? 1 }, (_, i) => ({ id: `map-${i}`, label: `Mapa demonstrativo ${i}` }));
  const catalog: RoomCatalog = {
    revision: 'ui-test', capabilities: { create: true, lookup: true, query: true, update: true, cancel: true, close: true }, maps,
    modes: Array.from({ length: opts.modes ?? 1 }, (_, i) => ({ id: `mode-${i}`, label: `Modo demonstrativo ${i}`, mapIds: maps.map(m => m.id), minPlayers: 2, maxPlayers: 50,
      editableFields: ['name', 'modeId', 'mapId', 'maxPlayers', 'password'], optionFields: opts.extras ?? [] })),
  };
  const provider = new Provider(catalog); const store = new Store(':memory:'); t.after(() => store.close());
  const service = new ManagedRoomsService(store, provider);
  await service.configure({ guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
    operatorRoleIds: ['operator'], managerRoleIds: ['manager'], viewerRoleIds: ['viewer'], allowedModeIds: [], allowedMapIds: [],
    maxActivePerUser: 10, maxActivePerGuild: 20, cooldownSeconds: 0 }, { userId: 'admin', administrator: true, roleIds: [] });
  const published: ManagedRoom[] = []; let panels = 0; let clock = 1000;
  const ui = new RoomInteractions(service, { async publish(room) { published.push(room); }, async publishPanel() { panels++; } }, () => clock);
  const make = (kind: FakeInteraction['kind'], customId: string, data: Record<string, string | number> = {}, values: string[] = [], user = 'owner', guild = 'guild', commandName = '') => new FakeInteraction(kind, customId, guild, users.get(user)!, users, data, values, commandName);
  const send = async (i: FakeInteraction) => { assert.equal(await ui.handle(i as unknown as Interaction), true); return i; };
  return { users, provider, store, service, ui, published, panels: () => panels, make, send, expire: () => { clock += 600_001; } };
}
function components(i: FakeInteraction): UIComponent[] { return (i.message().components ?? []).flatMap(row => row.components ?? []); }
function custom(i: FakeInteraction, contains: string): string {
  const id = components(i).find(c => c.custom_id?.includes(contains))?.custom_id;
  assert.ok(id, `Missing control ${contains}: ${JSON.stringify(i.message())}`); return id;
}
async function beforeDetails(f: Awaited<ReturnType<typeof setup>>) {
  const start = await f.send(f.make('button', 'room:new'));
  const mode = await f.send(f.make('select', custom(start, ':mode:'), {}, ['mode-0']));
  const map = await f.send(f.make('select', custom(mode, ':map:'), {}, ['map-0']));
  const details = await f.send(f.make('button', custom(map, ':details')));
  assert.ok(details.modal); return details.modal.custom_id;
}
async function preview(f: Awaited<ReturnType<typeof setup>>) {
  const id = await beforeDetails(f);
  return f.send(f.make('modal', id, { name: 'Sala cliente', maxPlayers: '12', password: 'PRIVATE123' }));
}

test('edição registra somente comandos de sala e apresenta painel específico', () => {
  assert.deepEqual(roomCommands.map(c => c.name).sort(), ['sala', 'salas']);
  const actions = roomCommands.find(c => c.name === 'sala')!.options!.map(o => o.name);
  for (const name of ['criar', 'consultar', 'status', 'atualizar', 'cancelar', 'encerrar']) assert.ok(actions.includes(name));
  assert.equal(roomPanel('guild').embeds[0]?.toJSON().footer?.text, 'ROOM_PANEL:guild');
});

test('assistente cria sala independente após selecionar modo/mapa/capacidade e confirmar prévia', async t => {
  const f = await setup(t); const check = await preview(f);
  assert.equal(f.provider.creates, 0); assert.equal(f.published.length, 0);
  assert.ok(!JSON.stringify(check.message()).includes('PRIVATE123'));
  assert.equal(f.service.list('guild', { userId: 'owner', administrator: false, roleIds: ['operator'] }).items[0]?.state, 'draft');
  const confirmed = await f.send(f.make('button', custom(check, ':confirm')));
  assert.equal(f.provider.creates, 1); assert.equal(f.published.length, 1);
  assert.equal(f.published[0]?.options.mapId, 'map-0'); assert.equal(f.published[0]?.options.maxPlayers, 12);
  assert.ok(JSON.stringify(confirmed.message()).includes('PRIVATE123'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM matches').get()?.n, 0);
});

test('modo e mapa com mais de25 opções são paginados sem exceder os limites do Discord', async t => {
  const f = await setup(t, { modes: 30, maps: 30 });
  const start = await f.send(f.make('button', 'room:new'));
  assert.equal(components(start).find(c => c.options)?.options?.length, 25);
  const page = await f.send(f.make('button', custom(start, ':mode-page:1')));
  assert.equal(components(page).find(c => c.options)?.options?.length, 5);
  const mode = await f.send(f.make('select', custom(page, ':mode:1'), {}, ['mode-29']));
  const map = await f.send(f.make('button', custom(mode, ':map-page:1')));
  assert.equal(components(map).find(c => c.options)?.options?.length, 5);
});

test('sessões não podem ser controladas por outra pessoa, servidor ou componente antigo', async t => {
  const f = await setup(t); const start = await f.send(f.make('button', 'room:new')); const id = custom(start, ':mode:');
  const stolen = await f.send(f.make('select', id, {}, ['mode-0'], 'other'));
  assert.match(stolen.message().content!, /outra pessoa/);
  const cross = await f.send(f.make('select', id, {}, ['mode-0'], 'owner', 'other-guild'));
  assert.match(cross.message().content!, /outro.*servidor|outra pessoa/);
  await f.send(f.make('select', id, {}, ['mode-0']));
  const stale = await f.send(f.make('select', id, {}, ['mode-0']));
  assert.match(stale.message().content!, /substituído/); assert.equal(f.provider.creates, 0);
});

test('sessão expira e cargo removido impede continuar ou confirmar', async t => {
  const f = await setup(t); const first = await f.send(f.make('button', 'room:new')); const id = custom(first, ':mode:');
  f.expire(); const expired = await f.send(f.make('select', id, {}, ['mode-0'])); assert.match(expired.message().content!, /expirou/);
  const check = await preview(f); f.users.get('owner')!.roles = [];
  const revoked = await f.send(f.make('button', custom(check, ':confirm')));
  assert.match(revoked.message().content!, /cargo/); assert.equal(f.provider.creates, 0);
});

test('capacidade inválida e opções não selecionadas não iniciam requisição externa', async t => {
  const f = await setup(t); const modal = await beforeDetails(f);
  const invalid = await f.send(f.make('modal', modal, { name: 'Sala', maxPlayers: '1.5', password: '' }));
  assert.match(invalid.message().content!, /inteiro/); assert.equal(f.provider.creates, 0);
  const outOfRange = await f.send(f.make('modal', modal, { name: 'Sala', maxPlayers: '999', password: '' }));
  assert.match(outOfRange.message().content!, /limites/); assert.equal(f.provider.creates, 0);
});

test('extras booleanos, escolhas e inteiros são coletados como campos tipados sem JSON arbitrário', async t => {
  const f = await setup(t, { extras: [
    { id: 'friendly', label: 'Opção booleana', type: 'boolean', required: true, editable: true },
    { id: 'rounds', label: 'Quantidade de rodadas', type: 'integer', required: true, min: 0, max: 10, editable: true },
    { id: 'style', label: 'Estilo', type: 'choice', required: true, editable: true, choices: [{ value: 'normal', label: 'Normal' }] },
  ] });
  const detailsId = await beforeDetails(f);
  const details = await f.send(f.make('modal', detailsId, { name: 'Com opções', maxPlayers: '12', password: '' }));
  const bool = await f.send(f.make('select', custom(details, ':extra:'), {}, ['true']));
  const openNumber = await f.send(f.make('button', custom(bool, ':extra-input'))); assert.ok(openNumber.modal);
  const number = await f.send(f.make('modal', openNumber.modal.custom_id, { value: '2' }));
  const choice = await f.send(f.make('select', custom(number, ':extra:'), {}, ['normal']));
  await f.send(f.make('button', custom(choice, ':confirm')));
  assert.deepEqual(f.published[0]?.options.extras, { friendly: true, rounds: 2, style: 'normal' });
});

test('formulário numérico aceita todos os dígitos de um inteiro seguro liberado pelo catálogo', async t => {
  const f = await setup(t, { extras: [
    { id: 'large', label: 'Inteiro seguro', type: 'integer', required: true, min: 1_000_000_000_000, max: Number.MAX_SAFE_INTEGER },
  ] });
  const detailsId = await beforeDetails(f);
  const details = await f.send(f.make('modal', detailsId, { name: 'Inteiro longo', maxPlayers: '12', password: '' }));
  const input = await f.send(f.make('button', custom(details, ':extra-input'))); assert.ok(input.modal);
  const field = input.modal.components.flatMap(c => c.components ?? [])[0] as UIComponent & { max_length?: number };
  assert.equal(field.max_length, String(Number.MIN_SAFE_INTEGER).length);
  const check = await f.send(f.make('modal', input.modal.custom_id, { value: String(Number.MAX_SAFE_INTEGER) }));
  await f.send(f.make('button', custom(check, ':confirm')));
  assert.equal(f.provider.creates, 1);
  assert.equal(f.published[0]?.options.extras.large, Number.MAX_SAFE_INTEGER);
});

test('resposta pendente não publica ID ou senha como se a sala estivesse confirmada', async t => {
  const f = await setup(t); f.provider.pendingCreate = true; const check = await preview(f);
  const pending = await f.send(f.make('button', custom(check, ':confirm')));
  assert.equal(f.provider.creates, 1); assert.equal(f.published.length, 0);
  assert.ok(!JSON.stringify(pending.message()).includes('PRIVATE123'));
  assert.match(pending.message().content!, /pendente/);
});

test('revogação de cargo durante API impede envio de senha na resposta privada', async t => {
  const f = await setup(t); const check = await preview(f);
  f.provider.onCreate = () => { f.users.get('owner')!.roles = []; };
  const response = await f.send(f.make('button', custom(check, ':confirm')));
  assert.equal(f.provider.creates, 1); assert.equal(f.published.length, 0);
  assert.ok(!JSON.stringify(response.message()).includes('PRIVATE123'));
  assert.match(response.message().content!, /acess|cargo|permiss/);
});

test('consultas de viewer omitem senhas, não oferecem ações de alteração e histórico é redigido', async t => {
  const f = await setup(t); const check = await preview(f); await f.send(f.make('button', custom(check, ':confirm')));
  const room = f.published[0]!;
  const response = await f.send(f.make('button', `room:sync:${room.id}`, {}, [], 'viewer'));
  assert.ok(!JSON.stringify(response.message()).includes('PRIVATE123'));
  assert.deepEqual(response.message().components, []);
  assert.ok(!JSON.stringify(roomEmbed(room, false).toJSON()).includes('PRIVATE123'));
});

test('cancelar exige formulário de motivo e só depois envia cancelamento remoto', async t => {
  const f = await setup(t); const check = await preview(f); await f.send(f.make('button', custom(check, ':confirm')));
  const room = f.published[0]!;
  const request = await f.send(f.make('button', `room:cancel:${room.id}`));
  assert.ok(request.modal); assert.equal(f.provider.cancels, 0);
  const response = await f.send(f.make('modal', request.modal.custom_id, { reason: 'Cancelamento solicitado pelo responsável.' }));
  assert.equal(f.provider.cancels, 1); assert.match(response.message().content!, /confirmada/);
  assert.equal(f.published.at(-1)?.state, 'cancelled');
});

test('edição mostra somente campos mutáveis e preserva opções imutáveis', async t => {
  const f = await setup(t, { extras: [
    { id: 'fixed', label: 'Regra fixada', type: 'integer', required: true, min: 0, max: 10, editable: false },
    { id: 'friendly', label: 'Regra alterável', type: 'boolean', required: true, editable: true },
  ] });
  f.provider.catalog.modes[0]!.editableFields = ['name'];
  const actor = { userId: 'owner', roleIds: ['operator'], administrator: false };
  const draft = await f.service.createDraft('guild', actor, { name: 'Original', modeId: 'mode-0', mapId: 'map-0', maxPlayers: 12, password: 'PRIVATE123', extras: { fixed: 7, friendly: true } });
  const created = await f.service.create('guild', draft.id, actor);
  const edit = await f.send(f.make('button', `room:edit:${created.id}`));
  const open = await f.send(f.make('button', custom(edit, ':details'))); assert.ok(open.modal);
  assert.deepEqual(open.modal.components.flatMap(c => c.components ?? []).map(c => c.custom_id), ['name']);
  const details = await f.send(f.make('modal', open.modal.custom_id, { name: 'Alterada' }));
  const extra = await f.send(f.make('select', custom(details, ':extra:'), {}, ['false']));
  await f.send(f.make('button', custom(extra, ':confirm')));
  const updated = f.service.get('guild', created.id, actor);
  assert.equal(f.provider.updates, 1); assert.equal(updated.options.name, 'Alterada');
  assert.equal(updated.options.maxPlayers, 12); assert.equal(updated.options.password, 'PRIVATE123');
  assert.deepEqual(updated.options.extras, { fixed: 7, friendly: false });
});

test('troca de modo coleta a opção obrigatória que será imutável na nova configuração', async t => {
  const f = await setup(t, { modes: 2 });
  f.provider.catalog.modes[1]!.optionFields = [
    { id: 'newFixed', label: 'Regra obrigatória do novo modo', type: 'boolean', required: true, editable: false },
  ];
  const actor = { userId: 'owner', roleIds: ['operator'], administrator: false };
  const draft = await f.service.createDraft('guild', actor, { name: 'Original', modeId: 'mode-0', mapId: 'map-0', maxPlayers: 12, password: 'PRIVATE123', extras: {} });
  const created = await f.service.create('guild', draft.id, actor);
  const edit = await f.send(f.make('button', `room:edit:${created.id}`));
  const mode = await f.send(f.make('select', custom(edit, ':mode:'), {}, ['mode-1']));
  const map = await f.send(f.make('select', custom(mode, ':map:'), {}, ['map-0']));
  const details = await f.send(f.make('button', custom(map, ':details'))); assert.ok(details.modal);
  const extra = await f.send(f.make('modal', details.modal.custom_id, { name: 'Novo modo', maxPlayers: '12', password: 'PRIVATE123' }));
  const check = await f.send(f.make('select', custom(extra, ':extra:'), {}, ['true']));
  await f.send(f.make('button', custom(check, ':confirm')));
  const updated = f.service.get('guild', created.id, actor);
  assert.equal(f.provider.updates, 1); assert.equal(updated.options.modeId, 'mode-1');
  assert.deepEqual(updated.options.extras, { newFixed: true });
  await assert.rejects(f.service.update('guild', created.id, actor, { ...updated.options, extras: { newFixed: false } }), { code: 'ROOM_FIELD_IMMUTABLE' });
  assert.equal(f.provider.updates, 1);
});

test('alteração da whitelist depois da prévia é revalidada antes de criar', async t => {
  const f = await setup(t, { maps: 2 }); const check = await preview(f);
  const cfg = f.service.settings('guild')!;
  await f.service.configure({ ...cfg, allowedMapIds: ['map-1'] }, { userId: 'admin', roleIds: [], administrator: true });
  await f.send(f.make('button', custom(check, ':confirm')));
  assert.equal(f.provider.creates, 0); assert.equal(f.published.length, 0);
});

test('confirmação consumida não pode gerar uma segunda sala', async t => {
  const f = await setup(t); const check = await preview(f); const confirmId = custom(check, ':confirm');
  await f.send(f.make('button', confirmId)); await f.send(f.make('button', confirmId));
  assert.equal(f.provider.creates, 1); assert.equal(f.published.length, 1);
});

test('configuração de canais, cargos e catálogo fica isolada da configuração de partidas', async t => {
  const f = await setup(t, { extras: [{ id: 'friendly', label: 'Regra', type: 'boolean', editable: true }] });
  const configured = await f.send(f.make('command', '', {
    sub: 'configurar', painel: 'new-panel', publicacao: 'new-output', operador: 'operator', gerente: 'manager', visualizador: 'viewer', logs: 'logs',
    modos: 'mode-0', mapas: 'map-0', extras: 'friendly', limite_usuario: 2, limite_servidor: 8, intervalo: 12,
  }, [], 'admin', 'guild', 'salas'));
  assert.match(configured.message().content!, /Configuração salva/);
  const cfg = f.service.settings('guild')!;
  assert.equal(cfg.outputChannelId, 'new-output'); assert.equal(cfg.maxActivePerGuild, 8);
  assert.deepEqual(cfg.allowedExtraIds, ['friendly']);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM guilds').get()?.n, 0);
  await f.send(f.make('command', '', { sub: 'painel' }, [], 'admin', 'guild', 'salas'));
  assert.equal(f.panels(), 1);
});

for (const invalid of ['name', 'password'] as const) test(`formulário permite corrigir ${invalid} inválido sem perder a sessão`, async t => {
  const f = await setup(t); const initial = await beforeDetails(f);
  const data = { name: invalid === 'name' ? 'x'.repeat(81) : 'Sala corrigível', maxPlayers: '12', password: invalid === 'password' ? 'senha com espaço' : 'PRIVATE123' };
  const failed = await f.send(f.make('modal', initial, data));
  assert.match(failed.message().content!, invalid === 'name' ? /nome/ : /senha/);
  assert.equal(f.provider.creates, 0);
  const reopened = await f.send(f.make('button', custom(failed, ':details'))); assert.ok(reopened.modal);
  const corrected = await f.send(f.make('modal', reopened.modal.custom_id, { name: 'Sala corrigida', maxPlayers: '12', password: 'PRIVATE123' }));
  assert.ok(!JSON.stringify(corrected.message()).includes('PRIVATE123'));
  await f.send(f.make('button', custom(corrected, ':confirm')));
  assert.equal(f.provider.creates, 1);
});

test('gerência consulta diagnóstico privado e recupera entrega esgotada sem acessar API de salas', async t => {
  const f = await setup(t); f.users.set('manager', { id: 'manager', roles: ['manager'] });
  const outbox = new DurableOutbox(f.store, { maxAttempts: 1 });
  outbox.enqueue('private-delivery-key', 'managed_room_panel', { guildId: 'guild', secret: 'PRIVATE_DELIVERY_TOKEN' });
  const job = outbox.claim('worker', 60_000)!; outbox.fail('worker', job, 'ROOM_BOT_PERMISSIONS');
  const diagnosis = await f.send(f.make('command', '', { sub: 'diagnostico' }, [], 'manager', 'guild', 'salas'));
  const serialized = JSON.stringify(diagnosis.message());
  assert.match(serialized, /Tentativas esgotadas/); assert.doesNotMatch(serialized, /PRIVATE_DELIVERY_TOKEN|private-delivery-key/);
  const reference = serialized.match(/`([a-f0-9]{32})`/)?.[1]; assert.ok(reference);
  assert.equal((diagnosis.replies[0] as { defer: { flags: number } }).defer.flags, MessageFlags.Ephemeral);
  const retry = await f.send(f.make('command', '', { sub: 'reprocessar', tarefa: reference, motivo: 'Permissões corrigidas no canal.' }, [], 'manager', 'guild', 'salas'));
  assert.match(retry.message().content!, /devolvida à fila/);
  assert.equal(outbox.get('private-delivery-key')?.state, 'pending');
  assert.equal(f.provider.creates, 0); assert.equal(f.provider.updates, 0); assert.equal(f.provider.closes, 0); assert.equal(f.provider.cancels, 0);
});

test('reprocessar revalida o membro depois do defer e bloqueia gerente com cargo removido', async t => {
  const f = await setup(t); f.users.set('manager', { id: 'manager', roles: ['manager'] });
  const outbox = new DurableOutbox(f.store, { maxAttempts: 1 });
  outbox.enqueue('delivery', 'managed_room_panel', { guildId: 'guild' });
  const job = outbox.claim('worker', 60_000)!; outbox.fail('worker', job, 'ROOM_BOT_PERMISSIONS');
  const diagnosis = await f.send(f.make('command', '', { sub: 'diagnostico' }, [], 'manager', 'guild', 'salas'));
  const reference = JSON.stringify(diagnosis.message()).match(/`([a-f0-9]{32})`/)?.[1]; assert.ok(reference);
  const retry = f.make('command', '', { sub: 'reprocessar', tarefa: reference, motivo: 'Permissões corrigidas.' }, [], 'manager', 'guild', 'salas');
  f.users.get('manager')!.roles = [];
  await f.send(retry);
  assert.match(retry.message().content!, /Somente a administração e a gerência/);
  assert.equal(outbox.get('delivery')?.state, 'dead');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_room_delivery_retries').get()?.n, 0);
});

test('operador não recebe diagnóstico nem referências das tarefas administrativas', async t => {
  const f = await setup(t); const outbox = new DurableOutbox(f.store);
  outbox.enqueue('secret-task-key', 'managed_room_panel', { guildId: 'guild', secret: 'PRIVATE_DELIVERY_TOKEN' });
  const response = await f.send(f.make('command', '', { sub: 'diagnostico' }, [], 'owner', 'guild', 'salas'));
  assert.match(response.message().content!, /Somente a administração e a gerência/);
  assert.doesNotMatch(JSON.stringify(response.message()), /PRIVATE_DELIVERY_TOKEN|secret-task-key|[a-f0-9]{32}/);
});
