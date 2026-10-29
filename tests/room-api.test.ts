import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { HttpRoomProvider, RoomApiError, type HttpRoomProviderOptions } from '../src/room-api.js';
import { DomainError } from '../src/domain.js';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';

const secret = 'private-provider-key-do-not-log';
const reference = 'partida-123';
const context = { id: reference, teamSize: 2, platform: 'mobile' as const, rules: 'Regras verificadas no teste.' };
const json = (res: ServerResponse, payload: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
};
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const http = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { res.destroy(error instanceof Error ? error : undefined); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const address = http.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
function options(baseUrl = 'https://rooms.example', overrides: Partial<HttpRoomProviderOptions> = {}): HttpRoomProviderOptions {
  return { contract: 'room-contract-v1', baseUrl, apiKey: secret, createPath: '/rooms', getMatch: () => context, ...overrides };
}
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('API exige contrato explícito, HTTPS e caminhos da mesma origem', () => {
  for (const baseUrl of ['http://rooms.example', 'https://user:password@rooms.example', 'https://rooms.example/?token=secret', 'https://rooms.example/path']) {
    assert.throws(() => new HttpRoomProvider(options(baseUrl)), errorCode('ROOM_API_CONFIG'));
  }
  for (const path of ['//other.example/path', 'https://other.example', '/rooms?token=secret', '/../rooms']) {
    assert.throws(() => new HttpRoomProvider(options(undefined, { createPath: path })), errorCode('ROOM_API_CONFIG'));
  }
  assert.throws(() => new HttpRoomProvider(options(undefined, { contract: undefined as unknown as 'room-contract-v1' })), errorCode('ROOM_API_CONFIG'));
  assert.throws(() => new HttpRoomProvider(options(undefined, { apiKey: 'key\r\nInjected: yes' })), errorCode('ROOM_API_CONFIG'));
  assert.throws(() => new HttpRoomProvider(options('http://127.0.0.1')), errorCode('ROOM_API_CONFIG'));
  assert.throws(() => new HttpRoomProvider(options('http://remote.example', { allowLocalHttpForTests: true })), errorCode('ROOM_API_CONFIG'));
});

test('identidade distingue contrato e endpoints sem depender da rotação da chave', () => {
  const provider = new HttpRoomProvider(options());
  const rotated = new HttpRoomProvider(options(undefined, { apiKey: 'rotated-secret' }));
  assert.equal(provider.identity, rotated.identity);
  assert.notEqual(provider.identity, new HttpRoomProvider(options('https://other-provider.example')).identity);
  assert.notEqual(provider.identity, new HttpRoomProvider(options(undefined, { lookupPath: '/lookup' })).identity);
  assert.ok(!JSON.stringify(provider).includes(secret));
});

test('criação envia referência estável, regras e autenticação apenas nos cabeçalhos', async t => {
  let requests = 0;
  const baseUrl = await server(t, async (req, res) => {
    requests++;
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/rooms');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers['idempotency-key'], reference);
    assert.deepEqual(await body(req), { reference, mode: '2x2', platform: 'mobile', rules: context.rules });
    json(res, { reference, room: { id: '12345678', password: 'senha123', source: 'simulated' }, untrusted: secret }, 201);
  });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  assert.deepEqual(await provider.createRoom(reference), { id: '12345678', password: 'senha123', source: 'external' });
  assert.equal(requests, 1);
});

test('consulta GET envia somente a referência na URL e não cria outra sala', async t => {
  let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests++;
    assert.equal(req.method, 'GET'); assert.equal(req.url, `/lookup?reference=${reference}`);
    assert.equal(req.headers.authorization, secret);
    assert.equal(req.headers['idempotency-key'], undefined);
    json(res, { reference, room: { id: '123', password: 'senha' } });
  });
  const provider = new HttpRoomProvider(options(baseUrl, { lookupPath: '/lookup', authorizationScheme: 'raw', allowLocalHttpForTests: true }));
  assert.equal((await provider.findRoom(reference))?.id, '123'); assert.equal(requests, 1);
});

test('consulta POST usa o endpoint configurado e o corpo de referência', async t => {
  const baseUrl = await server(t, async (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/lookup');
    assert.deepEqual(await body(req), { reference });
    json(res, { reference, room: { id: '123', password: 'senha' } });
  });
  const provider = new HttpRoomProvider(options(baseUrl, { lookupPath: '/lookup', lookupMethod: 'POST', allowLocalHttpForTests: true }));
  assert.equal((await provider.findRoom(reference))?.source, 'external');
});

test('consulta desabilitada não faz tráfego nem presume que uma sala não existe', async t => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => { requests++; json(res, { unexpected: true }); });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  assert.equal(await provider.findRoom(reference), undefined); assert.equal(requests, 0);
});

test('timeout depois de enviar criação não repete o POST nem expõe credenciais', async t => {
  let requests = 0;
  const baseUrl = await server(t, async req => { requests++; await body(req); });
  const provider = new HttpRoomProvider(options(baseUrl, { timeoutMs: 500, allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), error => {
    assert.ok(error instanceof RoomApiError); assert.equal(error.code, 'ROOM_API_UNCERTAIN');
    assert.ok(!String(error).includes(secret)); return true;
  });
  assert.equal(requests, 1);
});

test('redirecionamento é rejeitado sem encaminhar a chave ao destino', async t => {
  let redirected = 0; let creates = 0;
  const destination = await server(t, (_req, res) => { redirected++; json(res, { reference, room: { id: '123', password: 'senha' } }); });
  const baseUrl = await server(t, (_req, res) => { creates++; res.writeHead(307, { Location: destination }); res.end(); });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_UNCERTAIN'));
  assert.equal(redirected, 0); assert.equal(creates, 1);
});

test('4xx na criação permanece incerto e o corpo do fornecedor não aparece no erro', async t => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => { requests++; json(res, { token: secret, password: 'forbidden-password' }, 429); });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), error => {
    assert.ok(error instanceof RoomApiError); assert.equal(error.httpStatus, 429);
    assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!String(error).includes('forbidden-password')); return true;
  });
  assert.equal(requests, 1);
});

test('JSON malformado não inclui o corpo HTTP em mensagens ou causas de erro', async t => {
  const baseUrl = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(`invalid-json-${secret}`); });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), error => {
    assert.ok(error instanceof RoomApiError); assert.equal(error.code, 'ROOM_API_RESPONSE');
    assert.ok(!String(error).includes(secret)); assert.equal(error.cause, undefined); return true;
  });
});

test('resposta excessiva em streaming é limitada mesmo sem Content-Length', async t => {
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"oversize":"'); res.end('x'.repeat(4096) + '"}');
  });
  const provider = new HttpRoomProvider(options(baseUrl, { maxResponseBytes: 256, allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_RESPONSE'));
});

test('envelope de outra referência, campos inválidos e Content-Type incorreto são rejeitados', async t => {
  let response: unknown = { reference: 'other-match', room: { id: '123', password: 'senha' } };
  let contentType = 'application/json';
  const baseUrl = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': contentType }); res.end(JSON.stringify(response)); });
  const provider = new HttpRoomProvider(options(baseUrl, { allowLocalHttpForTests: true }));
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_RESPONSE'));
  response = { reference, room: { id: 123, password: 'senha' } };
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_RESPONSE'));
  response = { reference, room: { id: '123', password: '@everyone ||leak||' } };
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_RESPONSE'));
  contentType = 'text/plain'; response = { reference, room: { id: '123', password: 'senha' } };
  await assert.rejects(provider.createRoom(reference), errorCode('ROOM_API_RESPONSE'));
});

test('consulta pendente ou não encontrada mantém resultado indeterminado', async t => {
  let status = 202;
  const baseUrl = await server(t, (_req, res) => { json(res, { reference, status: 'pending' }, status); });
  const provider = new HttpRoomProvider(options(baseUrl, { lookupPath: '/lookup', allowLocalHttpForTests: true }));
  for (const code of [202, 404, 410, 200]) { status = code; assert.equal(await provider.findRoom(reference), undefined); }
});

test('domínio recupera a sala por HTTP após perder a resposta, sem repetir criação', async t => {
  let creates = 0; let queries = 0;
  const baseUrl = await server(t, async (req, res) => {
    if (req.method === 'POST') { creates++; await body(req); req.socket.destroy(); return; }
    queries++;
    const ref = new URL(req.url!, 'http://localhost').searchParams.get('reference');
    json(res, { reference: ref, room: { id: '7654321', password: 'senha' } });
  });
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new BotService(store); const actor = { userId: 'admin', moderator: true, mediator: false };
  service.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'mediator' }, actor);
  const q = service.createQueue('guild', actor, 1, 'mobile', 'Regras do fluxo HTTP de teste.');
  service.joinQueue('guild', q.id, 'p1'); const m = service.joinQueue('guild', q.id, 'p2').match!;
  service.confirm('guild', m.id, 'p1'); service.confirm('guild', m.id, 'p2'); service.claim('guild', m.id, actor);
  const provider = new HttpRoomProvider(options(baseUrl, { getMatch: id => service.match('guild', id), lookupPath: '/lookup', allowLocalHttpForTests: true }));
  await assert.rejects(service.createRoom('guild', m.id, actor, provider), errorCode('ROOM_UNCERTAIN'));
  assert.equal(service.match('guild', m.id).state, 'room_pending');
  await assert.rejects(service.createRoom('guild', m.id, actor, provider), errorCode('INVALID_STATE'));
  const found = await service.reconcileRoom('guild', m.id, provider);
  assert.equal(found.room?.id, '7654321'); assert.equal(found.room?.source, 'external');
  assert.equal(creates, 1); assert.equal(queries, 1);
});
