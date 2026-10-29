import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Store } from '../src/database.js';
import { DurableOutbox } from '../src/outbox.js';
import { DomainError } from '../src/domain.js';
import { loadRoomsConfig, managedRoomProvider, requireRoomsDiscord, checkRoomCapabilities } from '../src/rooms/config.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { roomCommands } from '../src/rooms/commands.js';
import { HttpManagedRoomProvider } from '../src/rooms/http-provider.js';
import { SimulatedManagedRoomProvider } from '../src/rooms/simulated-provider.js';
import type { RoomActor, RoomOptions, RoomSettings } from '../src/rooms/types.js';

test('edição de salas ignora configurações financeiras e não inicializa seus módulos', async () => {
  const config = loadRoomsConfig({ PAYMENT_PROVIDER: 'efi', EFI_CERT_FILE: '/missing-private-key', ROOM_MODE: 'api' });
  assert.equal(config.provider, 'simulated');
  const store = new Store(':memory:');
  try {
    const provider = managedRoomProvider(config, store); await checkRoomCapabilities(provider);
    new ManagedRoomsService(store, provider);
    const features = (store.db.prepare('SELECT feature FROM feature_migrations').all() as { feature: string }[]).map(r => r.feature);
    assert.ok(features.includes('managed_rooms'));
    assert.ok(!features.some(f => ['payments', 'billing', 'operations'].includes(f)));
    assert.deepEqual(roomCommands.map(c => c.name).sort(), ['sala', 'salas']);
  } finally { store.close(); }
});

test('configuração da API exige contrato novo e não aceita TLS relaxado por ambiente', () => {
  assert.throws(() => loadRoomsConfig({ ROOMS_PROVIDER: 'api', ROOMS_API_CONTRACT: 'room-contract-v1' }), DomainError);
  const config = loadRoomsConfig({ ROOMS_PROVIDER: 'api', ROOMS_API_CONTRACT: 'room-management-v2', ROOMS_API_URL: 'http://127.0.0.1', ROOMS_API_KEY: 'test-key' });
  const store = new Store(':memory:');
  try { assert.throws(() => managedRoomProvider(config, store), DomainError); }
  finally { store.close(); }
  assert.throws(() => requireRoomsDiscord(loadRoomsConfig({})), DomainError);
});

test('capacidade obrigatória ausente impede classificar o provedor como apto', async () => {
  const store = new Store(':memory:');
  try {
    const provider = managedRoomProvider(loadRoomsConfig({}), store);
    const catalog = await provider.getCatalog(); catalog.capabilities.close = false;
    await assert.rejects(checkRoomCapabilities({ ...provider, getCatalog: async () => catalog } as typeof provider), DomainError);
  } finally { store.close(); }
});

test('fila da edição de salas não captura nem encerra tarefas de módulos legados', () => {
  let time = 1; const store = new Store(':memory:');
  try {
    const jobs = new DurableOutbox(store, { now: () => time, maxAttempts: 1 });
    jobs.enqueue('legacy:1', 'sync_match', { id: 'legacy' });
    assert.equal(jobs.claim('legacy', 1)?.type, 'sync_match');
    time = 3; jobs.enqueue('rooms:1', 'managed_room_publish', { id: 'room' });
    const roomJob = jobs.claim('rooms', 10, ['managed_room_publish']); assert.ok(roomJob);
    assert.equal(roomJob.type, 'managed_room_publish');
    assert.equal(jobs.get('legacy:1')?.state, 'running');
    jobs.complete('rooms', roomJob);
    assert.equal(jobs.claim('rooms', 10, []), undefined);
    assert.equal(jobs.claim('legacy', 10), undefined);
    assert.equal(jobs.get('legacy:1')?.state, 'dead');
  } finally { store.close(); }
});

for (const command of ['main', 'register']) test(`CLI ${command} exige token antes de conectar e não lê credenciais PIX`, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../src/rooms/${command}.js`, import.meta.url))], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DISCORD_TOKEN: '', DISCORD_BOT_TOKEN: '', ROOMS_PROVIDER: 'simulated',
      PAYMENT_PROVIDER: 'efi', EFI_CERT_FILE: '/missing-private-key' },
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /DISCORD_TOKEN/);
  assert.ok(!result.stderr.includes('EFI_CERT_FILE'));
});

test('fluxo independente percorre domínio e API HTTP: criar, consultar, editar, encerrar e cancelar', async t => {
  const appStore = new Store(':memory:'); const apiStore = new Store(':memory:');
  const backend = new SimulatedManagedRoomProvider(apiStore);
  let creates = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer local-test-key');
      const url = new URL(request.url!, 'http://fixture');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const key = String(request.headers['idempotency-key'] ?? '');
      let data: unknown;
      if (url.pathname === '/v2/catalog') data = { catalog: await backend.getCatalog() };
      else if (url.pathname === '/v2/rooms/lookup') data = { room: await backend.findRoom(url.searchParams.get('reference')!) };
      else if (url.pathname === '/v2/rooms' && request.method === 'POST') {
        creates++; data = { room: await backend.createRoom({ ...body, idempotencyKey: key }) };
      } else {
        const [remoteId, action] = url.pathname.slice('/v2/rooms/'.length).split('/').map(decodeURIComponent);
        assert.ok(remoteId);
        if (request.method === 'PATCH') data = { room: await backend.updateRoom(remoteId, body.options, key) };
        else if (action === 'cancel') data = { room: await backend.cancelRoom(remoteId, key, body.reason) };
        else if (action === 'close') data = { room: await backend.closeRoom(remoteId, key, body.reason) };
        else data = { room: await backend.getRoom(remoteId) };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    })().catch(() => { response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    appStore.close(); apiStore.close();
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const provider = new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'local-test-key', allowLocalHttpForTests: true });
  const service = new ManagedRoomsService(appStore, provider);
  const actor: RoomActor = { userId: 'creator', administrator: true, roleIds: [] };
  const settings: RoomSettings = { guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
    operatorRoleIds: ['operator'], managerRoleIds: ['manager'], viewerRoleIds: [],
    allowedModeIds: [], allowedMapIds: [], maxActivePerUser: 5, maxActivePerGuild: 10, cooldownSeconds: 0 };
  await service.configure(settings, actor);
  const options: RoomOptions = { name: 'HTTP room', modeId: 'demo-standard', mapId: 'demo-island', maxPlayers: 10, extras: { rounds: 3 } };
  const draft = await service.createDraft('guild', actor, options);
  const created = await service.create('guild', draft.id, actor);
  assert.equal(created.state, 'ready'); assert.equal(created.source, 'external');
  await service.create('guild', draft.id, actor); assert.equal(creates, 1);
  const updated = await service.update('guild', draft.id, actor, { ...options, mapId: 'demo-desert', maxPlayers: 12 });
  assert.equal(updated.confirmed?.mapId, 'demo-desert');
  assert.equal((await backend.getRoom(updated.confirmed!.id)).maxPlayers, 12);
  assert.equal((await service.synchronize('guild', draft.id, actor)).state, 'ready');
  assert.equal((await service.close('guild', draft.id, actor, 'Encerrar pela API de teste.')).state, 'closed');
  const second = await service.createDraft('guild', actor, { ...options, name: 'Cancel HTTP room' });
  await service.create('guild', second.id, actor);
  const cancelled = await service.cancel('guild', second.id, actor, 'Cancelar pela API de teste.');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await backend.getRoom(cancelled.confirmed!.id)).state, 'cancelled');
  assert.equal(appStore.db.prepare('SELECT COUNT(*) AS total FROM matches').get()?.total, 0);
});
