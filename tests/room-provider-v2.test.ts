import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database.js';
import { DomainError } from '../src/domain.js';
import { HttpManagedRoomProvider, normalizeManagedCatalog } from '../src/rooms/http-provider.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { SimulatedManagedRoomProvider } from '../src/rooms/simulated-provider.js';
import type { ProviderRoom, RoomCatalog, RoomOptions } from '../src/rooms/types.js';

const options: RoomOptions = { name: 'Sala de teste', modeId: 'mode-a', mapId: 'map-a', maxPlayers: 10, password: 'private-password', extras: { rounds: 7 } };
const catalog: RoomCatalog = {
  revision: 'catalog-v1', maps: [{ id: 'map-a', label: 'Mapa A' }, { id: 'map-b', label: 'Mapa B' }],
  modes: [{ id: 'mode-a', label: 'Modo A', mapIds: ['map-a', 'map-b'], minPlayers: 2, maxPlayers: 50, playerStep: 1,
    editableFields: ['name', 'mapId', 'maxPlayers', 'password'],
    optionFields: [{ id: 'rounds', label: 'Rodadas', type: 'integer', min: 1, max: 13, editable: true }] }],
  capabilities: { create: true, query: true, lookup: true, update: true, cancel: true, close: true },
};
const room = (overrides: Partial<ProviderRoom> = {}): ProviderRoom => ({
  id: 'REMOTE-1', reference: 'request-1', state: 'open', name: options.name,
  modeId: options.modeId, mapId: options.mapId, maxPlayers: options.maxPlayers,
  password: options.password!, extras: options.extras, ...overrides,
});
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
async function payload(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown;
}
async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, extra: { timeoutMs?: number; maxResponseBytes?: number; now?: () => number } = {}) {
  const errors: unknown[] = [];
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const provider = new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl, apiKey: 'DO-NOT-LOG-THIS-SECRET', allowLocalHttpForTests: true, ...extra });
  return { provider, baseUrl, errors };
}
const isDomain = (error: unknown) => error instanceof DomainError;
const isRateLimited = (error: unknown) => error instanceof DomainError && error.code === 'ROOM_PROVIDER_RATE_LIMITED';

test('provedor exige contrato, origem HTTPS e configuração explícita para HTTP local', () => {
  assert.throws(() => new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl: 'http://api.example.test', apiKey: 'x' }), isDomain);
  assert.throws(() => new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl: 'http://127.0.0.1', apiKey: 'x' }), isDomain);
  for (const baseUrl of ['https://u:p@example.test', 'https://example.test/path', 'https://example.test?key=secret']) {
    assert.throws(() => new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl, apiKey: 'x' }), isDomain);
  }
  assert.throws(() => new HttpManagedRoomProvider({ contract: 'wrong' as 'room-management-v2', baseUrl: 'https://example.test', apiKey: 'x' }), isDomain);
});

test('catálogo valida capacidades, mapas, opções, editabilidade e ausência de duplicatas', () => {
  assert.deepEqual(normalizeManagedCatalog(catalog), catalog);
  const duplicate = structuredClone(catalog); duplicate.maps.push(duplicate.maps[0]!);
  assert.throws(() => normalizeManagedCatalog(duplicate), isDomain);
  const map = structuredClone(catalog); map.modes[0]!.mapIds = ['missing'];
  assert.throws(() => normalizeManagedCatalog(map), isDomain);
  const field = structuredClone(catalog); field.modes[0]!.optionFields[0]!.max = 0;
  assert.throws(() => normalizeManagedCatalog(field), isDomain);
  const editable = structuredClone(catalog); editable.modes[0]!.editableFields = ['name', 'name'];
  assert.throws(() => normalizeManagedCatalog(editable), isDomain);
  const capabilities = { ...catalog, capabilities: { create: true } };
  assert.throws(() => normalizeManagedCatalog(capabilities), isDomain);
});

test('catálogo, criação, consulta, edição, cancelamento e encerramento percorrem HTTP real', async t => {
  const writes: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer DO-NOT-LOG-THIS-SECRET');
    if (req.url === '/v2/catalog') { json(res, { catalog }); return; }
    if (req.method === 'GET') { json(res, { room: room() }); return; }
    const body = await payload(req); writes.push({ method: req.method!, path: req.url!, body, key: req.headers['idempotency-key'] as string | undefined });
    if (req.url!.endsWith('/cancel')) json(res, { room: room({ state: 'cancelled' }) });
    else if (req.url!.endsWith('/close')) json(res, { room: room({ state: 'closed' }) });
    else if (req.method === 'PATCH') json(res, { room: room({ mapId: 'map-b', maxPlayers: 12 }) });
    else json(res, { room: room() }, 201);
  });
  assert.deepEqual(await f.provider.getCatalog(), catalog);
  assert.equal((await f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }))?.id, 'REMOTE-1');
  assert.equal((await f.provider.getRoom('REMOTE-1')).state, 'open');
  assert.equal((await f.provider.findRoom('request-1'))?.reference, 'request-1');
  const changed = { ...options, mapId: 'map-b', maxPlayers: 12 };
  assert.equal((await f.provider.updateRoom('REMOTE-1', changed, 'edit-1'))?.mapId, 'map-b');
  assert.equal((await f.provider.cancelRoom('REMOTE-1', 'cancel-1', 'Operador cancelou.'))?.state, 'cancelled');
  assert.equal((await f.provider.closeRoom('REMOTE-1', 'close-1', 'Operação encerrada.'))?.state, 'closed');
  assert.deepEqual(writes, [
    { method: 'POST', path: '/v2/rooms', body: { reference: 'request-1', options }, key: 'create-1' },
    { method: 'PATCH', path: '/v2/rooms/REMOTE-1', body: { options: changed }, key: 'edit-1' },
    { method: 'POST', path: '/v2/rooms/REMOTE-1/cancel', body: { reason: 'Operador cancelou.' }, key: 'cancel-1' },
    { method: 'POST', path: '/v2/rooms/REMOTE-1/close', body: { reason: 'Operação encerrada.' }, key: 'close-1' },
  ]);
  assert.deepEqual(f.errors, []);
});

test('202 mantém escrita pendente sem fabricar sala ou repetir requisição', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { calls++; req.resume(); res.writeHead(202); res.end(); });
  assert.equal(await f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }), undefined);
  assert.equal(await f.provider.updateRoom('REMOTE-1', options, 'update-1'), undefined);
  assert.equal(await f.provider.cancelRoom('REMOTE-1', 'cancel-1', 'Teste'), undefined);
  assert.equal(await f.provider.closeRoom('REMOTE-1', 'close-1', 'Teste'), undefined);
  assert.equal(calls, 4);
});

test('429 respeita Retry-After em segundos e bloqueia leituras/escritas sem retentativa', async t => {
  let now = 1_000_000; let calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++; req.resume();
    if (calls === 1) { res.writeHead(429, { 'retry-after': '120' }); res.end('DO-NOT-LOG-THIS-SECRET'); }
    else json(res, { catalog });
  }, { now: () => now });
  await assert.rejects(f.provider.getCatalog(), error => isRateLimited(error) && !(error as Error).message.includes('SECRET'));
  await assert.rejects(f.provider.findRoom('request-1'), isRateLimited);
  await assert.rejects(f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }), isRateLimited);
  await assert.rejects(f.provider.updateRoom('REMOTE-1', options, 'update-1'), isRateLimited);
  now += 119_999; await assert.rejects(f.provider.getCatalog(), isRateLimited);
  assert.equal(calls, 1);
  now++; assert.deepEqual(await f.provider.getCatalog(), catalog); assert.equal(calls, 2);
});

test('429 interpreta data HTTP e mantém cooldown isolado de outra origem', async t => {
  let now = Date.UTC(2026, 0, 1); let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(429, { 'retry-after': new Date(now + 120_000).toUTCString() }); res.end(); }
    else json(res, { catalog });
  }, { now: () => now });
  const other = await fixture(t, (_req, res) => json(res, { catalog }), { now: () => now });
  await assert.rejects(f.provider.getCatalog(), isRateLimited);
  assert.deepEqual(await other.provider.getCatalog(), catalog);
  now += 119_999; await assert.rejects(f.provider.getCatalog(), isRateLimited); assert.equal(calls, 1);
  now++; assert.deepEqual(await f.provider.getCatalog(), catalog); assert.equal(calls, 2);
});

test('429 sem Retry-After válido usa cooldown de segurança sem ecoar cabeçalho', async t => {
  for (const header of [null, 'invalid-PRIVATE-SECRET', '-5', 'Fri, 01 Jan 2021 00:00:00 GMT']) {
    let now = Date.UTC(2026, 0, 1); let calls = 0;
    const f = await fixture(t, (_req, res) => {
      calls++;
      if (calls === 1) { res.writeHead(429, header === null ? {} : { 'retry-after': header }); res.end(); }
      else json(res, { catalog });
    }, { now: () => now });
    await assert.rejects(f.provider.getCatalog(), error => isRateLimited(error) && !(error as Error).message.includes('PRIVATE'));
    now += 29_999; await assert.rejects(f.provider.getCatalog(), isRateLimited); assert.equal(calls, 1);
    now++; await f.provider.getCatalog(); assert.equal(calls, 2);
  }
});

test('429 limita espera excessiva e evita nova chamada imediata com Retry-After zero', async t => {
  for (const [header, expected] of [['99999999999999999999999999', 86_400_000], ['Thu, 01 Jan 2099 00:00:00 GMT', 86_400_000], ['0', 1000]] as const) {
    let now = Date.UTC(2026, 0, 1); let calls = 0;
    const f = await fixture(t, (_req, res) => {
      calls++;
      if (calls === 1) { res.writeHead(429, { 'retry-after': header }); res.end(); }
      else json(res, { catalog });
    }, { now: () => now });
    await assert.rejects(f.provider.getCatalog(), isRateLimited);
    now += expected - 1; await assert.rejects(f.provider.getCatalog(), isRateLimited); assert.equal(calls, 1);
    now++; await f.provider.getCatalog(); assert.equal(calls, 2);
  }
});

test('429 após criar conserva operação incerta e recupera por referência sem repetir POST', async t => {
  let now = Date.UTC(2026, 0, 1); let writes = 0; let lookups = 0; let remote: ProviderRoom | undefined;
  const f = await fixture(t, async (req, res) => {
    if (req.method === 'POST') {
      writes++;
      const body = await payload(req) as { reference: string; options: RoomOptions };
      remote = room({ ...body.options, reference: body.reference });
      res.writeHead(429, { 'retry-after': '120' }); res.end('PRIVATE-REMOTE-RESULT');
    } else if (req.url!.startsWith('/v2/rooms/lookup')) { lookups++; json(res, { room: remote }); }
    else json(res, { catalog });
  }, { now: () => now });
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new ManagedRoomsService(store, f.provider, () => now);
  const actor = { userId: 'creator', administrator: true, roleIds: [] };
  await service.configure({ guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
    operatorRoleIds: ['operator'], managerRoleIds: [], viewerRoleIds: [], allowedModeIds: [], allowedMapIds: [],
    maxActivePerUser: 5, maxActivePerGuild: 10, cooldownSeconds: 0 }, actor);
  const draft = await service.createDraft('guild', actor, options);
  const pending = await service.create('guild', draft.id, actor);
  assert.equal(pending.state, 'uncertain'); assert.equal(pending.pending?.kind, 'create');
  assert.equal(pending.lastErrorCode, 'ROOM_PROVIDER_RATE_LIMITED'); assert.equal(pending.confirmed, null);
  await service.create('guild', draft.id, actor);
  const stillPending = await service.synchronize('guild', draft.id, actor);
  assert.equal(stillPending.pending?.id, pending.pending?.id); assert.equal(writes, 1); assert.equal(lookups, 0);
  now += 120_000;
  const confirmed = await service.synchronize('guild', draft.id, actor);
  assert.equal(confirmed.state, 'ready'); assert.equal(confirmed.pending, null); assert.equal(confirmed.confirmed?.id, remote!.id);
  assert.equal(writes, 1); assert.equal(lookups, 1); assert.deepEqual(f.errors, []);
});

test('lookup 404 não autoriza recriar e consulta por ID ausente não vira cancelamento', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; json(res, { message: 'not found' }, 404); });
  assert.equal(await f.provider.findRoom('request-1'), undefined);
  await assert.rejects(f.provider.getRoom('REMOTE-1'), isDomain); assert.equal(calls, 2);
});

test('timeout após envio de escrita não repete pedido nem revela credencial', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    calls++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ room: room() })), 250).unref();
  }, { timeoutMs: 100 });
  await assert.rejects(f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }), error => {
    assert.ok(error instanceof DomainError); assert.ok(!error.message.includes('SECRET')); return true;
  });
  assert.equal(calls, 1);
});

test('redirect não leva autorização a outro destino e erro HTTP não ecoa corpo', async t => {
  let destination = 0;
  const target = await fixture(t, (_req, res) => { destination++; json(res, { room: room() }); });
  const f = await fixture(t, (req, res) => { req.resume(); res.writeHead(307, { location: target.baseUrl + '/v2/rooms' }); res.end('DO-NOT-LOG-THIS-SECRET'); });
  await assert.rejects(f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }), error => isDomain(error) && !(error as Error).message.includes('SECRET'));
  assert.equal(destination, 0);
  assert.ok(!JSON.stringify(f.provider).includes('SECRET')); assert.ok(!inspect(f.provider).includes('SECRET'));
});

test('JSON, tamanho, IDs e estados inválidos são recusados antes de divulgar dados', async t => {
  let value: unknown = { room: room({ reference: 'other-reference' }) };
  const f = await fixture(t, (_req, res) => json(res, value), { maxResponseBytes: 512 });
  await assert.rejects(f.provider.createRoom({ reference: 'request-1', options, idempotencyKey: 'create-1' }), isDomain);
  value = { room: room({ id: 'OTHER-ID' }) }; await assert.rejects(f.provider.getRoom('REMOTE-1'), isDomain);
  value = { room: room({ state: 'unknown' as ProviderRoom['state'] }) }; await assert.rejects(f.provider.getRoom('REMOTE-1'), isDomain);
  value = { room: room(), enormous: 'x'.repeat(1000) }; await assert.rejects(f.provider.getRoom('REMOTE-1'), isDomain);
  const invalid = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json SECRET'); });
  await assert.rejects(invalid.provider.getCatalog(), error => isDomain(error) && !(error as Error).message.includes('SECRET'));
});

test('identidade diferencia fornecedor, não muda com rotação de token e descarta campos externos', async t => {
  const f = await fixture(t, (_req, res) => json(res, { room: { ...room(), source: 'simulated', secretInternal: 'never-forward' } }));
  const rotated = new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl: f.baseUrl, apiKey: 'different-token', allowLocalHttpForTests: true });
  const other = new HttpManagedRoomProvider({ contract: 'room-management-v2', baseUrl: 'https://different.example.test', apiKey: 'different-token' });
  assert.equal(rotated.identity, f.provider.identity); assert.notEqual(other.identity, f.provider.identity);
  assert.equal(f.provider.source, 'external'); assert.ok(!JSON.stringify(await f.provider.getRoom('REMOTE-1')).includes('never-forward'));
});

test('simulador persiste o ciclo completo e idempotência após reabrir SQLite', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-provider-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'bot.sqlite'); let store = new Store(filename); let provider = new SimulatedManagedRoomProvider(store);
  const settings: RoomOptions = { name: 'Sala DEMO', modeId: 'demo-standard', mapId: 'demo-island', maxPlayers: 10, extras: { rounds: 7, friendlyFire: false } };
  let created = await provider.createRoom({ reference: 'create-demo', options: settings, idempotencyKey: 'demo-create' });
  assert.equal(provider.source, 'simulated'); assert.ok(created.id.startsWith('SIM-'));
  assert.equal((await provider.createRoom({ reference: 'create-demo', options: settings, idempotencyKey: 'demo-create' })).id, created.id);
  store.close(); store = new Store(filename); provider = new SimulatedManagedRoomProvider(store);
  try {
    assert.equal((await provider.findRoom('create-demo'))?.id, created.id);
    created = await provider.updateRoom(created.id, { ...settings, mapId: 'demo-desert', maxPlayers: 12 }, 'demo-update');
    assert.equal(created.mapId, 'demo-desert');
    assert.equal((await provider.closeRoom(created.id, 'demo-close', 'Fim do teste')).state, 'closed');
    assert.equal((await provider.getRoom(created.id)).state, 'closed');
    await assert.rejects(provider.cancelRoom(created.id, 'demo-cancel', 'Teste'), isDomain);
  } finally { store.close(); }
});

test('simulador rejeita reutilização de chave com opções diferentes e catálogo incompatível', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const provider = new SimulatedManagedRoomProvider(store);
  const settings: RoomOptions = { name: 'DEMO', modeId: 'demo-duel', mapId: 'demo-island', maxPlayers: 4, extras: { rounds: 7 } };
  const created = await provider.createRoom({ reference: 'demo-ref', options: settings, idempotencyKey: 'create-key' });
  await assert.rejects(provider.createRoom({ reference: 'demo-ref', options: { ...settings, maxPlayers: 6 }, idempotencyKey: 'create-key' }), isDomain);
  await assert.rejects(provider.createRoom({ reference: 'demo-other', options: { ...settings, mapId: 'demo-desert' }, idempotencyKey: 'other-key' }), isDomain);
  await assert.rejects(provider.updateRoom(created.id, { ...settings, maxPlayers: 3 }, 'edit-key'), isDomain);
  assert.equal((await provider.cancelRoom(created.id, 'cancel-key', 'Cancelamento demonstrado')).state, 'cancelled');
});
