import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelType, Collection, DiscordAPIError, OverwriteType, PermissionFlagsBits,
  type APIEmbed, type Client, type EmbedBuilder,
} from 'discord.js';
import { Store } from '../src/database.js';
import { DomainError } from '../src/domain.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { SimulatedManagedRoomProvider } from '../src/rooms/simulated-provider.js';
import { ManagedRoomsRuntime } from '../src/rooms/runtime.js';
import { RoomDeliveryOperations } from '../src/rooms/operations.js';
import { DurableOutbox } from '../src/outbox.js';
import type { ManagedRoom, RoomOptions, RoomSettings } from '../src/rooms/types.js';

type Payload = { embeds: EmbedBuilder[]; components?: unknown[] };
const everyone = { id: 'guild', permissions: { has: () => false } };
const role = (id: string) => ({ id, permissions: { has: () => false } });
const admin = { userId: 'admin', roleIds: [] as string[], administrator: true };
const owner = { userId: 'owner', roleIds: ['operator'], administrator: false };
const settings: RoomSettings = {
  guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
  operatorRoleIds: ['operator'], managerRoleIds: ['manager'], viewerRoleIds: ['viewer'],
  allowedModeIds: [], allowedMapIds: [], maxActivePerUser: 5, maxActivePerGuild: 20, cooldownSeconds: 0,
};
const options: RoomOptions = {
  name: 'Sala demonstrativa de entrega', modeId: 'demo-standard', mapId: 'demo-island',
  maxPlayers: 10, password: 'SECRET123', extras: {},
};
const hasSecret = (message: FakeMessage) => JSON.stringify(message.embeds).includes('SECRET123');
function missingMessage(): DiscordAPIError {
  return new DiscordAPIError({ code: 10008, message: 'Unknown Message' }, 10008, 404, 'GET', '/messages/id', {});
}
class FakeMessage {
  readonly author = { id: 'bot' };
  embeds: APIEmbed[] = [];
  components: unknown[] = [];
  edits = 0;
  onEdit: (() => Promise<void>) | undefined;
  constructor(readonly id: string) {}
  async edit(payload: Payload): Promise<FakeMessage> {
    this.embeds = payload.embeds.map(embed => embed.toJSON()); this.components = payload.components ?? [];
    this.edits++; if (this.onEdit) await this.onEdit(); return this;
  }
}
class FakeChannel {
  readonly type = ChannelType.GuildText;
  readonly guildId = 'guild';
  readonly permissionOverwrites = { cache: new Collection<string, { id: string; type: OverwriteType; allow: { has: (flag: bigint) => boolean } }>() };
  readonly records = new Collection<string, FakeMessage>();
  publicVisible = false;
  guestRoleVisible = false;
  viewerVisible = false;
  operatorVisible = false;
  denyMessageFetch = false;
  forceReads = 0;
  onRead: (() => Promise<void>) | undefined;
  sends = 0;
  readonly messages = { fetch: async (value: { message?: string; force?: boolean; limit?: number }) => {
    if (this.onRead) await this.onRead();
    if (value.message) {
      if (value.force) this.forceReads++;
      if (this.denyMessageFetch) throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'GET', '/messages/id', {});
      const message = this.records.get(value.message); if (!message) throw missingMessage(); return message;
    }
    return this.records;
  } };
  constructor(readonly id: string) {}
  permissionsFor(value: { id: string }) {
    const allowed = value.id === 'bot' || value.id === 'guild' ? value.id === 'bot' || this.publicVisible
      : value.id === 'guest' ? this.guestRoleVisible : value.id === 'viewer' ? this.viewerVisible : value.id === 'operator' ? this.operatorVisible : value.id === 'manager';
    return { has: (flag: bigint | readonly bigint[]) => Array.isArray(flag) ? value.id === 'bot' : allowed };
  }
  async send(payload: Payload): Promise<FakeMessage> {
    const message = new FakeMessage(`${this.id}-message-${++this.sends}`);
    await message.edit(payload); this.records.set(message.id, message); return message;
  }
}
function transport() {
  const channels = new Collection<string, FakeChannel>(['output', 'panel', 'other-output', 'logs'].map(id => [id, new FakeChannel(id)]));
  const roles = new Collection<string, typeof everyone>([['guild', everyone], ...['operator', 'manager', 'viewer', 'guest'].map(id => [id, role(id)] as const)]);
  let explicitViewerAllowed = true;
  let ownerOperatorAllowed = true;
  const guild = {
    id: 'guild',
    channels: { async fetch(id: string) { return channels.get(id) ?? null; } },
    roles: { everyone, async fetch() { return roles; } },
    members: {
      async fetchMe() { return { id: 'bot' }; },
      async fetch(input: { user: string }) {
        const roleId = input.user === 'owner' || input.user === 'other-operator' ? 'operator' : 'viewer';
        const allowed = roleId === 'operator' ? ownerOperatorAllowed : explicitViewerAllowed;
        return { id: input.user, permissions: { has: () => false }, roles: { cache: new Collection(allowed ? [[roleId, role(roleId)]] : []) } };
      },
    },
  };
  const client = {
    user: { id: 'bot' }, guilds: { cache: new Collection([['guild', guild]]), async fetch() { return guild; } },
    on() {}, off() {},
  } as unknown as Client;
  return { client, channels, guild, revokeViewer: () => { explicitViewerAllowed = false; }, revokeOwner: () => { ownerOperatorAllowed = false; } };
}
async function setup(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const provider = new SimulatedManagedRoomProvider(store); const service = new ManagedRoomsService(store, provider);
  await service.configure(settings, admin); const external = transport();
  const runtime = new ManagedRoomsRuntime(external.client, service, store);
  const draft = await service.createDraft('guild', owner, options);
  return { store, provider, service, runtime, draft, ...external };
}
async function created(f: Awaited<ReturnType<typeof setup>>): Promise<ManagedRoom> {
  return f.service.create('guild', f.draft.id, owner);
}

test('publicação não divulga ID ou senha antes da confirmação do provedor', async t => {
  const f = await setup(t); await f.runtime.publish(f.draft);
  assert.equal(f.channels.get('output')!.sends, 0);
  const room = await created(f); await f.runtime.publish(room);
  const message = [...f.channels.get('output')!.records.values()][0]!;
  assert.ok(hasSecret(message)); assert.ok(message.embeds[0]?.title?.includes('SIMULAÇÃO'));
  assert.equal(f.service.getForDelivery('guild', room.id).publicationMessageId, message.id);
});

test('configuração alterada durante leitura aborta antes de enviar dados ao canal antigo', async t => {
  const f = await setup(t); const room = await created(f); await f.runtime.publish(room);
  const output = f.channels.get('output')!;
  output.onRead = async () => { output.onRead = undefined; await f.service.configure({ ...settings, outputChannelId: 'other-output' }, admin); };
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_SETTINGS_CHANGED');
  assert.equal(output.sends, 1); assert.equal(f.channels.get('other-output')!.sends, 0);
  await f.runtime.publish(room);
  assert.ok(!hasSecret([...output.records.values()][0]!));
  assert.ok(hasSecret([...f.channels.get('other-output')!.records.values()][0]!));
});

test('configuração alterada durante envio remove dados antes de tentar a nova publicação', async t => {
  const f = await setup(t); const room = await created(f); await f.runtime.publish(room);
  const output = f.channels.get('output')!; const message = [...output.records.values()][0]!;
  const updated = await f.service.update('guild', room.id, owner, { ...options, maxPlayers: 12 });
  message.onEdit = async () => { message.onEdit = undefined; await f.service.configure({ ...settings, outputChannelId: 'other-output' }, admin); };
  await assert.rejects(f.runtime.publish(updated), error => error instanceof DomainError && error.code === 'ROOM_SETTINGS_CHANGED');
  assert.ok(!hasSecret(message)); assert.equal(f.channels.get('other-output')!.sends, 0);
  await f.runtime.publish(updated);
  assert.equal(f.channels.get('other-output')!.sends, 1);
});

test('mensagem excluída e interrupção antes de salvar referência não criam sala ou duplicam publicação', async t => {
  const f = await setup(t); const room = await created(f);
  await f.runtime.publish(room); const output = f.channels.get('output')!;
  const first = [...output.records.values()][0]!;
  // Simula interrupção depois do envio e antes de gravar IDs locais.
  f.store.db.prepare('UPDATE managed_rooms SET payload=json_set(payload,\'$.publicationMessageId\',NULL,\'$.publicationChannelId\',NULL) WHERE id=?').run(room.id);
  const resumed = new ManagedRoomsRuntime(f.client, f.service, f.store);
  await resumed.publish(room); assert.equal(output.sends, 1);
  output.records.delete(first.id); await resumed.publish(room);
  assert.equal(output.sends, 2);
  assert.ok(output.forceReads >= 1);
  assert.equal((await f.provider.findRoom(room.reference))?.id, room.confirmed?.id);
});

test('erro 403 ao ler uma publicação não é tratado como mensagem excluída', async t => {
  const f = await setup(t); const room = await created(f); await f.runtime.publish(room);
  const output = f.channels.get('output')!; output.denyMessageFetch = true;
  await assert.rejects(f.runtime.publish(room), error => error instanceof DiscordAPIError && error.code === 50013);
  assert.equal(output.sends, 1);
});

test('canal público é bloqueado e perda de restrição remove segredos da mensagem existente', async t => {
  const f = await setup(t); const room = await created(f); const output = f.channels.get('output')!;
  output.publicVisible = true;
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_PUBLIC_CHANNEL');
  assert.equal(output.sends, 0); output.publicVisible = false;
  await f.runtime.publish(room); const message = [...output.records.values()][0]!; assert.ok(hasSecret(message));
  output.publicVisible = true;
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_PUBLIC_CHANNEL');
  assert.ok(!hasSecret(message)); assert.equal(message.components.length, 0); assert.equal(output.sends, 1);
});

test('cargos e permissões individuais não autorizados são revalidados sem depender de versão da sala', async t => {
  const f = await setup(t); const room = await created(f); const output = f.channels.get('output')!;
  await f.runtime.publish(room); const message = [...output.records.values()][0]!;
  output.guestRoleVisible = true;
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_UNAUTHORIZED_ROLE');
  assert.ok(!hasSecret(message)); output.guestRoleVisible = false;
  output.permissionOverwrites.cache.set('explicit-viewer', { id: 'explicit-viewer', type: OverwriteType.Member, allow: { has: flag => flag === PermissionFlagsBits.ViewChannel } });
  await f.runtime.publish(room); assert.ok(!hasSecret(message));
  f.revokeViewer();
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_UNAUTHORIZED_MEMBER');
  assert.ok(!hasSecret(message));
});

test('canal de visualizadores recebe informações sem senha e mudança de ACL invalida o cache de segredo', async t => {
  const f = await setup(t); const room = await created(f); const output = f.channels.get('output')!;
  await f.runtime.publish(room); const message = [...output.records.values()][0]!;
  assert.ok(hasSecret(message));
  output.viewerVisible = true;
  await f.runtime.publish(room);
  assert.ok(!hasSecret(message));
  assert.ok(message.embeds[0]?.fields?.some(field => field.name === 'ID da sala'));
  assert.equal(output.sends, 1);
  output.viewerVisible = false;
  await f.runtime.publish(room); assert.ok(hasSecret(message));
});

test('canal compartilhado por operadores não divulga senha de outro criador', async t => {
  const f = await setup(t); const room = await created(f); const output = f.channels.get('output')!;
  output.operatorVisible = true; await f.runtime.publish(room);
  const message = [...output.records.values()][0]!;
  assert.ok(!hasSecret(message));
  assert.equal(f.service.get('guild', room.id, owner).confirmed?.password, 'SECRET123');
  assert.throws(() => f.service.get('guild', room.id, { userId: 'other-operator', roleIds: ['operator'], administrator: false }));
});

test('permissão individual do criador revela senha só enquanto seu cargo de operador permanece válido', async t => {
  const f = await setup(t); const room = await created(f); const output = f.channels.get('output')!;
  output.permissionOverwrites.cache.set('owner', { id: 'owner', type: OverwriteType.Member, allow: { has: flag => flag === PermissionFlagsBits.ViewChannel } });
  await f.runtime.publish(room); const message = [...output.records.values()][0]!;
  assert.ok(hasSecret(message));
  output.permissionOverwrites.cache.set('other-operator', { id: 'other-operator', type: OverwriteType.Member, allow: { has: flag => flag === PermissionFlagsBits.ViewChannel } });
  await f.runtime.publish(room); assert.ok(!hasSecret(message));
  output.permissionOverwrites.cache.delete('other-operator');
  await f.runtime.publish(room); assert.ok(hasSecret(message));
  f.revokeOwner();
  await assert.rejects(f.runtime.publish(room), error => error instanceof DomainError && error.code === 'ROOM_UNAUTHORIZED_MEMBER');
  assert.ok(!hasSecret(message));
});

test('troca de canal remove dados antigos antes de publicar no destino configurado', async t => {
  const f = await setup(t); const room = await created(f); await f.runtime.publish(room);
  const previous = [...f.channels.get('output')!.records.values()][0]!;
  await f.service.configure({ ...settings, outputChannelId: 'other-output' }, admin);
  await f.runtime.publish(room);
  assert.ok(!hasSecret(previous)); assert.equal(previous.components.length, 0);
  assert.ok(hasSecret([...f.channels.get('other-output')!.records.values()][0]!));
  assert.equal(f.service.getForDelivery('guild', room.id).publicationChannelId, 'other-output');
});

test('estado alterado durante envio é atualizado na próxima reconciliação e encerramento remove senha', async t => {
  const f = await setup(t); const room = await created(f); await f.runtime.publish(room);
  const message = [...f.channels.get('output')!.records.values()][0]!;
  const updated = await f.service.update('guild', room.id, owner, { ...options, maxPlayers: 12 });
  message.onEdit = async () => { message.onEdit = undefined; await f.service.close('guild', room.id, owner, 'Encerramento solicitado.'); };
  await f.runtime.publish(updated);
  assert.equal(f.service.getForDelivery('guild', room.id).state, 'closed');
  await f.runtime.publish(updated);
  assert.ok(message.embeds[0]?.fields?.some(field => field.value === 'Encerrada'));
  assert.ok(!hasSecret(message));
});

test('painel persiste, é recuperado após excluir mensagem e não contém dados de entrada', async t => {
  const f = await setup(t); await f.runtime.publishPanel('guild');
  const panel = f.channels.get('panel')!; const first = [...panel.records.values()][0]!;
  assert.equal(f.service.settings('guild')?.panelMessageId, first.id);
  assert.ok(!hasSecret(first));
  panel.records.delete(first.id); await f.runtime.publishPanel('guild');
  assert.equal(panel.sends, 2);
  const restarted = new ManagedRoomsRuntime(f.client, f.service, f.store); await restarted.publishPanel('guild');
  assert.equal(panel.sends, 2);
});

test('publicação é retomada com SQLite reaberto sem recriar sala no provedor', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-delivery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rooms.sqlite'); let store = new Store(path);
  const external = transport(); let provider = new SimulatedManagedRoomProvider(store); let service = new ManagedRoomsService(store, provider);
  await service.configure(settings, admin); const draft = await service.createDraft('guild', owner, options);
  const room = await service.create('guild', draft.id, owner); const runtime = new ManagedRoomsRuntime(external.client, service, store);
  await runtime.publish(room); store.close(); store = new Store(path); t.after(() => store.close());
  provider = new SimulatedManagedRoomProvider(store); service = new ManagedRoomsService(store, provider);
  await new ManagedRoomsRuntime(external.client, service, store).publish(service.getForDelivery('guild', room.id));
  assert.equal(external.channels.get('output')!.sends, 1);
  assert.equal((await provider.findRoom(room.reference))?.id, room.confirmed?.id);
});

test('outbox de entrega usa somente IDs/metadados e auditoria não divulga senha nem ID remoto', async t => {
  const f = await setup(t); await f.service.configure({ ...settings, logChannelId: 'logs' }, admin);
  const room = await created(f); await f.runtime.publish(room); await f.runtime.sweepOnce();
  const jobs = JSON.stringify(f.store.db.prepare('SELECT payload FROM outbox_jobs').all());
  assert.ok(!jobs.includes('SECRET123')); assert.ok(!jobs.includes(room.confirmed!.id));
  const logs = JSON.stringify([...f.channels.get('logs')!.records.values()].map(m => m.embeds));
  assert.ok(!logs.includes('SECRET123')); assert.ok(!logs.includes(room.confirmed!.id));
  const outbox = new DurableOutbox(f.store); assert.ok(outbox.stats().done >= 1);
});

test('histórico encerrado e painel estáveis evitam leituras a cada sweep e recuperam mensagens periodicamente', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t); const room = await created(f);
  await f.service.close('guild', room.id, owner, 'Evento concluído.');
  await f.runtime.sweepOnce();
  const output = f.channels.get('output')!; const panel = f.channels.get('panel')!;
  const roomReads = output.forceReads; const panelReads = panel.forceReads;
  const outbox = new DurableOutbox(f.store);
  const revision = outbox.get(`managed-publish:${room.id}`)!.revision;
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.equal(output.forceReads, roomReads); assert.equal(panel.forceReads, panelReads);
  assert.equal(outbox.get(`managed-publish:${room.id}`)!.revision, revision);
  output.records.clear(); panel.records.clear();
  t.mock.timers.tick(45_000); await f.runtime.sweepOnce();
  assert.equal(output.sends, 1); assert.equal(panel.sends, 2);
  t.mock.timers.tick(240_000); await f.runtime.sweepOnce();
  assert.equal(output.sends, 2);
  assert.ok(!hasSecret([...output.records.values()][0]!));
});

test('alterar versão ou destino do histórico invalida a espera da verificação periódica', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t); const room = await created(f);
  await f.service.close('guild', room.id, owner, 'Evento concluído.');
  await f.runtime.publish(room); await f.runtime.publishPanel('guild'); await f.runtime.sweepOnce();
  const output = f.channels.get('output')!; const before = output.forceReads;
  await f.service.synchronize('guild', room.id, owner);
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.ok(output.forceReads > before);
  await f.service.configure({ ...settings, panelChannelId: 'logs', outputChannelId: 'other-output' }, admin);
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.equal(f.channels.get('other-output')!.sends, 1);
  assert.equal(f.channels.get('logs')!.sends, 1);
  assert.equal(f.service.getForDelivery('guild', room.id).publicationChannelId, 'other-output');
  assert.equal(f.service.settings('guild')?.panelMessageId, [...f.channels.get('logs')!.records.values()][0]!.id);
});

test('publicações ativas continuam revalidando ACL a cada quinze segundos sem mudar o estado da sala', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t); const room = await created(f);
  await f.runtime.publish(room); await f.runtime.sweepOnce();
  const output = f.channels.get('output')!; const message = [...output.records.values()][0]!;
  const version = f.service.getForDelivery('guild', room.id).version;
  assert.ok(hasSecret(message)); output.viewerVisible = true;
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.equal(f.service.getForDelivery('guild', room.id).version, version);
  assert.ok(!hasSecret(message));
});

test('histórico grande é verificado em lotes justos sem atrasar publicação de sala ativa', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t);
  const history: ManagedRoom[] = [];
  for (let index = 0; index < 25; index++) {
    const draft = index === 0 ? f.draft : await f.service.createDraft('guild', owner, { ...options, name: `Histórico ${index}` });
    await f.service.create('guild', draft.id, owner);
    history.push(await f.service.close('guild', draft.id, owner, 'Evento concluído.'));
  }
  const activeDraft = await f.service.createDraft('guild', owner, { ...options, name: 'Sala ativa prioritária' });
  const active = await f.service.create('guild', activeDraft.id, owner);
  await f.runtime.sweepOnce();
  const output = f.channels.get('output')!;
  assert.equal(output.sends, 11);
  assert.ok(f.service.getForDelivery('guild', active.id).publicationMessageId);
  assert.equal(history.filter(room => f.service.getForDelivery('guild', room.id).publicationMessageId).length, 10);
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.equal(history.filter(room => f.service.getForDelivery('guild', room.id).publicationMessageId).length, 20);
  t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
  assert.equal(history.filter(room => f.service.getForDelivery('guild', room.id).publicationMessageId).length, 25);
});

test('reconciliação dá vez a mais de vinte criações pendentes sem mudar updated_at', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t);
  await f.service.configure({ ...settings, maxActivePerUser: 50, maxActivePerGuild: 100 }, admin);
  f.service.provider.createRoom = async () => undefined;
  const lookedUp: string[] = [];
  f.provider.findRoom = async reference => { lookedUp.push(reference); return undefined; };
  const rooms: ManagedRoom[] = [];
  for (let index = 0; index < 25; index++) {
    const draft = index === 0 ? f.draft : await f.service.createDraft('guild', owner, { ...options, name: `Pendente ${index}` });
    rooms.push(await f.service.create('guild', draft.id, owner));
  }
  try {
    for (let index = 0; index < 3; index++) {
      await f.runtime.sweepOnce();
      await new Promise<void>(resolve => setImmediate(resolve));
      t.mock.timers.tick(15_000);
    }
    assert.equal(new Set(lookedUp).size, 25);
    for (const room of rooms) {
      const current = f.service.getForDelivery('guild', room.id);
      assert.equal(current.updatedAt, room.updatedAt);
      assert.equal(current.state, 'creating');
      assert.equal(current.pending?.id, room.pending?.id);
    }
  } finally { await f.runtime.stop(); }
});

test('API lenta não bloqueia entrega nem remoção de senha após revogar acesso', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t); const room = await created(f);
  await f.runtime.publish(room);
  const output = f.channels.get('output')!; const message = [...output.records.values()][0]!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const readStarted = new Promise<void>(resolve => { started = resolve; });
  const read = f.provider.getRoom.bind(f.provider); let calls = 0;
  f.provider.getRoom = async id => { calls++; started(); await gate; return read(id); };
  let sweepDone = false;
  const sweep = f.runtime.sweepOnce().then(() => { sweepDone = true; });
  try {
    await readStarted; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sweepDone, true, 'a publicação deve terminar enquanto a API ainda está aguardando');
    assert.ok(hasSecret(message)); output.viewerVisible = true;
    t.mock.timers.tick(15_000); await f.runtime.sweepOnce();
    assert.ok(!hasSecret(message)); assert.equal(calls, 1);
  } finally { release(); await sweep; await f.runtime.stop(); }
});

test('reconciliação limita leituras concorrentes e parada aguarda apenas as já iniciadas', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t);
  await f.service.configure({ ...settings, maxActivePerUser: 20, maxActivePerGuild: 100 }, admin);
  for (let index = 0; index < 12; index++) {
    const draft = index === 0 ? f.draft : await f.service.createDraft('guild', owner, { ...options, name: `Concorrente ${index}` });
    await f.service.create('guild', draft.id, owner);
  }
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const read = f.provider.getRoom.bind(f.provider);
  let active = 0; let maximum = 0; let calls = 0;
  f.provider.getRoom = async id => {
    calls++; active++; maximum = Math.max(maximum, active);
    try { await gate; return read(id); } finally { active--; }
  };
  let stopped = false; let stopping: Promise<void> | undefined;
  try {
    await f.runtime.sweepOnce();
    assert.equal(calls, 3); assert.equal(maximum, 3);
    stopping = f.runtime.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release(); await stopping;
    assert.equal(active, 0); assert.equal(calls, 3); assert.equal(stopped, true);
    t.mock.timers.tick(30_000); await f.runtime.sweepOnce(); assert.equal(calls, 3);
  } finally { release(); await stopping; await f.runtime.stop(); }
});

test('confirmação recebida em segundo plano fica na outbox e é publicada no próximo sweep', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const f = await setup(t); const create = f.service.provider.createRoom.bind(f.service.provider);
  let writes = 0;
  f.service.provider.createRoom = async request => { writes++; await create(request); return undefined; };
  const pending = await created(f); assert.equal(pending.state, 'creating');
  const find = f.provider.findRoom.bind(f.provider);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.provider.findRoom = async reference => { await gate; return find(reference); };
  const output = f.channels.get('output')!;
  try {
    await f.runtime.sweepOnce(); assert.equal(output.sends, 0);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.service.getForDelivery('guild', pending.id).state, 'ready');
    assert.equal(new DurableOutbox(f.store).get(`managed-publish:${pending.id}`)?.state, 'pending');
    assert.equal(output.sends, 0);
    await f.runtime.sweepOnce(); assert.equal(output.sends, 1); assert.equal(writes, 1);
    assert.ok(hasSecret([...output.records.values()][0]!));
  } finally { release(); await f.runtime.stop(); }
});

test('gerência recupera entrega esgotada após corrigir permissão sem criar outra sala e mantém auditoria', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.mock.method(console, 'error', () => {});
  const f = await setup(t); const create = f.service.provider.createRoom.bind(f.service.provider);
  let creates = 0;
  f.service.provider.createRoom = async request => { creates++; return create(request); };
  const initial = await created(f);
  // A terminal room has a stable confirmed snapshot while delivery is retried.
  const room = await f.service.close('guild', initial.id, owner, 'Evento encerrado antes de publicar o histórico.');
  const output = f.channels.get('output')!; output.publicVisible = true;
  const outbox = new DurableOutbox(f.store); const key = `managed-publish:${room.id}`;
  const operations = new RoomDeliveryOperations(f.service);
  const manager = { userId: 'manager-user', administrator: false, roleIds: ['manager'] };
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const previous = outbox.get(key);
      if (previous) t.mock.timers.tick(previous.availableAt - Date.now());
      await f.runtime.sweepOnce();
      const task = outbox.get(key)!;
      assert.equal(task.attempts, attempt);
      assert.equal(task.state, attempt === 8 ? 'dead' : 'pending');
      assert.equal(task.lastError, 'ROOM_PUBLIC_CHANNEL');
    }
    const exhausted = outbox.get(key)!;
    assert.equal(output.sends, 0);
    output.publicVisible = false; t.mock.timers.tick(15_000);
    await f.runtime.sweepOnce();
    assert.equal(output.sends, 0);
    assert.equal(outbox.get(key)?.state, 'dead');
    assert.equal(outbox.get(key)?.revision, exhausted.revision);
    const diagnosis = operations.diagnose('guild', manager);
    const task = diagnosis.items.find(item => item.type === 'managed_room_publish' && item.state === 'dead');
    assert.ok(task);
    operations.retry('guild', manager, task.reference, 'Permissão corrigida; SECRET123 continua restrita.');
    assert.equal(outbox.get(key)?.state, 'pending');
    await f.runtime.sweepOnce();
    assert.equal(outbox.get(key)?.state, 'done');
    assert.equal(output.sends, 1); assert.equal(creates, 1);
    assert.equal(f.service.getForDelivery('guild', room.id).confirmed?.id, initial.confirmed?.id);
    const message = [...output.records.values()][0]!;
    assert.ok(message.embeds[0]?.fields?.some(field => field.name === 'ID da sala' && field.value.includes(initial.confirmed!.id)));
    assert.ok(!hasSecret(message));
    const audit = f.store.db.prepare('SELECT * FROM managed_room_delivery_retries').all();
    assert.equal(audit.length, 1); assert.equal(audit[0]?.actor_id, manager.userId);
    assert.equal(audit[0]?.previous_revision, exhausted.revision);
    assert.equal(audit[0]?.next_revision, exhausted.revision + 1);
    assert.doesNotMatch(JSON.stringify(audit), /SECRET123/);
    assert.match(String(audit[0]?.reason), /\[REDACTED\]/);
    assert.throws(() => f.store.db.prepare('DELETE FROM managed_room_delivery_retries').run(), /append-only/);
  } finally { await f.runtime.stop(); }
});
