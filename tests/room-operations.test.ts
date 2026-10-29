import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/database.js';
import { DomainError } from '../src/domain.js';
import { DurableOutbox, type JsonValue } from '../src/outbox.js';
import { RoomDeliveryOperations } from '../src/rooms/operations.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { SimulatedManagedRoomProvider } from '../src/rooms/simulated-provider.js';
import type { RoomActor, RoomSettings } from '../src/rooms/types.js';

const admin: RoomActor = { userId: 'admin', administrator: true, roleIds: [] };
const manager: RoomActor = { userId: 'manager-user', administrator: false, roleIds: ['manager'] };
const operator: RoomActor = { userId: 'operator-user', administrator: false, roleIds: ['operator'] };
const settings: RoomSettings = { guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
  operatorRoleIds: ['operator'], managerRoleIds: ['manager'], viewerRoleIds: ['viewer'], allowedModeIds: [], allowedMapIds: [],
  maxActivePerUser: 5, maxActivePerGuild: 10, cooldownSeconds: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function setup(t: TestContext, filename = ':memory:') {
  const store = new Store(filename); t.after(() => store.close());
  const provider = new SimulatedManagedRoomProvider(store); const service = new ManagedRoomsService(store, provider);
  await service.configure(settings, admin);
  await service.configure({ ...settings, guildId: 'other-guild', managerRoleIds: ['other-manager'] }, admin);
  const outbox = new DurableOutbox(store, { maxAttempts: 1 }); const operations = new RoomDeliveryOperations(service);
  const dead = (key: string, type: string, payload: JsonValue, error = 'ROOM_BOT_PERMISSIONS') => {
    outbox.enqueue(key, type, payload);
    const job = outbox.claim('worker', 60_000, [type]); assert.ok(job); assert.equal(job.key, key);
    assert.equal(outbox.fail('worker', job, error), true); assert.equal(outbox.get(key)?.state, 'dead');
  };
  return { store, provider, service, outbox, operations, dead };
}

test('diagnóstico é isolado por servidor/tipos e só devolve referências e erros seguros', async t => {
  const f = await setup(t);
  f.dead('private-key-containing-secret', 'managed_room_publish', { guildId: 'guild', password: 'PRIVATE_PASSWORD', remoteId: 'PRIVATE_REMOTE_ID' }, 'PRIVATE_ACCESS_KEY');
  f.dead('other-guild-key', 'managed_room_publish', { guildId: 'other-guild', password: 'OTHER_PASSWORD' });
  f.dead('legacy-key', 'sync_match', { guildId: 'guild', token: 'LEGACY_TOKEN' });
  const diagnosis = f.operations.diagnose('guild', manager);
  assert.deepEqual(diagnosis.counts, { pending: 0, running: 0, done: 0, dead: 1 });
  assert.equal(diagnosis.total, 1); assert.equal(diagnosis.items[0]?.lastError, 'ROOM_DELIVERY_FAILED');
  assert.match(diagnosis.items[0]!.reference, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(diagnosis), /PRIVATE|OTHER_PASSWORD|LEGACY_TOKEN|private-key|payload|remoteId/);
  assert.throws(() => f.operations.diagnose('other-guild', manager), code('FORBIDDEN'));
});

test('diagnóstico paginado prioriza tarefas esgotadas e não repete itens entre páginas', async t => {
  const f = await setup(t);
  for (let index = 0; index < 12; index++) f.dead(`task-${index}`, 'managed_room_panel', { guildId: 'guild' });
  f.outbox.enqueue('pending-task', 'managed_room_panel', { guildId: 'guild' });
  const first = f.operations.diagnose('guild', manager); const second = f.operations.diagnose('guild', admin, 2);
  assert.equal(first.items.length, 10); assert.equal(second.items.length, 3); assert.equal(first.total, 13);
  assert.ok(first.items.every(task => task.state === 'dead'));
  assert.equal(new Set([...first.items, ...second.items].map(task => task.reference)).size, 13);
  assert.throws(() => f.operations.diagnose('guild', manager, 0), code('ROOM_PAGE'));
});

test('somente gerência/admin podem diagnosticar ou reprocessar com cargos atualmente configurados', async t => {
  const f = await setup(t); f.dead('room-task', 'managed_room_publish', { guildId: 'guild' });
  const reference = f.operations.diagnose('guild', manager).items[0]!.reference;
  for (const actor of [operator, { userId: 'viewer', administrator: false, roleIds: ['viewer'] }]) {
    assert.throws(() => f.operations.diagnose('guild', actor), code('FORBIDDEN'));
    assert.throws(() => f.operations.retry('guild', actor, reference, 'Acesso corrigido.'), code('FORBIDDEN'));
  }
  await f.service.configure({ ...settings, managerRoleIds: ['new-manager'] }, admin);
  assert.throws(() => f.operations.retry('guild', manager, reference, 'Acesso corrigido.'), code('FORBIDDEN'));
  assert.equal(f.outbox.get('room-task')?.state, 'dead');
  f.operations.retry('guild', admin, reference, 'Permissões revisadas.');
  assert.equal(f.outbox.get('room-task')?.state, 'pending');
});

test('reprocessamento recupera apenas entrega morta, registra auditoria e não repete sala na API', async t => {
  const f = await setup(t);
  const draft = await f.service.createDraft('guild', admin, { name: 'Room', modeId: 'demo-standard', mapId: 'demo-island', maxPlayers: 10, password: 'PRIVATE_ROOM_PASSWORD', extras: {} });
  const room = await f.service.create('guild', draft.id, admin);
  f.dead('delivery-only', 'managed_room_publish', { guildId: 'guild', id: room.id });
  const reference = f.operations.diagnose('guild', manager).items[0]!.reference;
  const before = f.outbox.get('delivery-only')!;
  const result = f.operations.retry('guild', manager, reference, 'Permissão corrigida; PRIVATE_ROOM_PASSWORD removida.');
  assert.equal(result.revision, before.revision + 1);
  assert.equal(f.outbox.get('delivery-only')?.state, 'pending');
  assert.equal(f.outbox.get('delivery-only')?.attempts, 0);
  assert.equal(f.service.getForDelivery('guild', room.id).version, room.version);
  const rows = f.store.db.prepare('SELECT * FROM managed_room_delivery_retries').all();
  assert.equal(rows.length, 1); assert.equal(rows[0]?.actor_id, manager.userId);
  assert.match(String(rows[0]?.reason), /\[REDACTED\]/); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_ROOM_PASSWORD/);
  assert.throws(() => f.operations.retry('guild', manager, reference, 'Clique repetido.'), code('ROOM_DELIVERY_NOT_FAILED'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_room_delivery_retries').get()?.n, 1);
  assert.throws(() => f.store.db.prepare('DELETE FROM managed_room_delivery_retries').run(), /append-only/);
});

test('tarefa de outro servidor, tarefa legada e referência inválida nunca são recuperadas', async t => {
  const f = await setup(t);
  f.dead('foreign', 'managed_room_panel', { guildId: 'other-guild' });
  f.dead('legacy', 'sync_match', { guildId: 'guild' });
  const reference = f.operations.diagnose('other-guild', admin).items[0]!.reference;
  assert.throws(() => f.operations.retry('guild', admin, reference, 'Correção autorizada.'), code('ROOM_DELIVERY_NOT_FOUND'));
  assert.throws(() => f.operations.retry('guild', admin, 'legacy', 'Correção autorizada.'), code('ROOM_TASK_REFERENCE'));
  assert.equal(f.outbox.get('foreign')?.state, 'dead'); assert.equal(f.outbox.get('legacy')?.state, 'dead');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_room_delivery_retries').get()?.n, 0);
});

test('tarefas pendentes, concluídas ou com lease ativo não são reprocessadas', async t => {
  const f = await setup(t);
  f.outbox.enqueue('running', 'managed_room_panel', { guildId: 'guild' });
  const running = f.outbox.claim('worker', 60_000)!;
  f.outbox.enqueue('done', 'managed_room_publish', { guildId: 'guild' });
  const done = f.outbox.claim('worker', 60_000)!; f.outbox.complete('worker', done);
  f.outbox.enqueue('pending', 'managed_room_redact', { guildId: 'guild' });
  for (const task of f.operations.diagnose('guild', manager).items) {
    assert.throws(() => f.operations.retry('guild', manager, task.reference, 'Entrega revisada.'), code('ROOM_DELIVERY_NOT_FAILED'));
  }
  assert.equal(f.outbox.get('running')?.state, 'running'); assert.equal(f.outbox.get('running')?.leaseUntil, running.leaseUntil);
  assert.equal(f.outbox.get('done')?.state, 'done'); assert.equal(f.outbox.get('pending')?.state, 'pending');
});

test('falha de auditoria desfaz recuperação e motivo inválido não modifica tarefa', async t => {
  const f = await setup(t); f.dead('task', 'managed_room_publish', { guildId: 'guild' });
  const reference = f.operations.diagnose('guild', manager).items[0]!.reference;
  for (const reason of ['', 'ab', 'bad\nreason', 'a'.repeat(301)]) {
    assert.throws(() => f.operations.retry('guild', manager, reference, reason), code('ROOM_RETRY_REASON'));
  }
  f.store.db.exec("CREATE TRIGGER reject_retry BEFORE INSERT ON managed_room_delivery_retries BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(() => f.operations.retry('guild', manager, reference, 'Correção revisada.'), /audit unavailable/);
  assert.equal(f.outbox.get('task')?.state, 'dead'); assert.equal(f.outbox.get('task')?.revision, 1);
});

test('referências e auditoria permanecem válidas após reabrir o SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-ops-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'rooms.sqlite');
  let store = new Store(filename);
  const service = new ManagedRoomsService(store, new SimulatedManagedRoomProvider(store)); await service.configure(settings, admin);
  const outbox = new DurableOutbox(store, { maxAttempts: 1 }); outbox.enqueue('persistent', 'managed_room_panel', { guildId: 'guild' });
  const job = outbox.claim('worker', 60_000)!; outbox.fail('worker', job, 'ROOM_BOT_PERMISSIONS');
  const before = new RoomDeliveryOperations(service).diagnose('guild', manager).items[0]!.reference;
  store.close(); store = new Store(filename); t.after(() => store.close());
  const restarted = new RoomDeliveryOperations(new ManagedRoomsService(store, new SimulatedManagedRoomProvider(store)));
  assert.equal(restarted.diagnose('guild', manager).items[0]!.reference, before);
  restarted.retry('guild', manager, before, 'Permissões corrigidas após reinício.');
  assert.equal(new DurableOutbox(store).get('persistent')?.state, 'pending');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM managed_room_delivery_retries').get()?.n, 1);
});
