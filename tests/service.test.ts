import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { DomainError, parseMoney, type Actor, type Match } from '../src/domain.js';
import { RoomNotCreatedError, SimulatedRoomProvider, type RoomProvider } from '../src/providers.js';
import { loadConfig, requireDiscord } from '../src/config.js';
import { commands } from '../src/bot/commands.js';
import { matchEmbed } from '../src/bot/presentation.js';

const admin: Actor = { userId: 'admin', moderator: true, mediator: false };
const med: Actor = { userId: 'med', moderator: false, mediator: true };
const outsider: Actor = { userId: 'outsider', moderator: false, mediator: false };
function setup(t: TestContext, now?: () => number) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new BotService(store, 30_000, now);
  service.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med-role' }, admin);
  const q = service.createQueue('guild', admin, 1, 'mobile', 'Sem dinheiro; regras de teste.');
  return { store, service, q };
}
function form(service: BotService, queueId: string, size = 1): Match {
  let m: Match | undefined;
  for (let i = 0; i < size * 2; i++) m = service.joinQueue('guild', queueId, `player-${i}`).match ?? m;
  assert.ok(m); return m;
}
function ready(service: BotService, qid: string): Match {
  const m = form(service, qid);
  for (const p of m.players) service.confirm('guild', m.id, p.userId);
  return service.claim('guild', m.id, med);
}
function playing(service: BotService, qid: string): Match {
  const m = ready(service, qid);
  service.informRoom('guild', m.id, med, '12345678', 'senha123');
  return service.startMatch('guild', m.id, med);
}
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;

for (const size of [1, 2, 3, 4]) test(`fila ${size}x${size}: reserva exatamente dois times sem duplicar jogadores`, t => {
  const { service } = setup(t);
  const q = service.createQueue('guild', admin, size, 'misto', 'Regras iguais para os dois times.');
  const m = form(service, q.id, size);
  assert.equal(m.players.length, size * 2);
  assert.equal(m.players.filter(p => p.team === 1).length, size);
  assert.equal(m.players.filter(p => p.team === 2).length, size);
  assert.equal(service.queuePlayers('guild', q.id).length, 0);
  assert.throws(() => service.joinQueue('guild', q.id, 'player-0'), code('ALREADY_ACTIVE'));
  assert.equal(service.matches('guild').length, 1);
});

test('entrada repetida, saída e filas incompatíveis preservam uma reserva por jogador', t => {
  const { service, q } = setup(t);
  assert.equal(service.joinQueue('guild', q.id, 'p').alreadyJoined, false);
  assert.equal(service.joinQueue('guild', q.id, 'p').alreadyJoined, true);
  const other = service.createQueue('guild', admin, 1, 'emulador', 'Outro regulamento.');
  assert.throws(() => service.joinQueue('guild', other.id, 'p'), code('ALREADY_ACTIVE'));
  service.leaveQueue('guild', q.id, 'p'); service.joinQueue('guild', other.id, 'p');
  assert.deepEqual(service.queuePlayers('guild', other.id), ['p']);
});

test('cliques recebidos juntos não formam duas partidas com os mesmos jogadores', async t => {
  const { service, q } = setup(t);
  await Promise.allSettled(['a', 'b', 'a', 'b'].map(user => Promise.resolve().then(() => service.joinQueue('guild', q.id, user))));
  assert.equal(service.matches('guild').length, 1);
  assert.equal(service.matches('guild')[0]?.players.length, 2);
});

test('expiração libera jogadores e botão antigo não reativa a partida', t => {
  let clock = 1000;
  const { service, q } = setup(t, () => clock);
  const m = form(service, q.id); clock += 30_001;
  assert.throws(() => service.confirm('guild', m.id, 'player-0'), code('INVALID_STATE'));
  assert.equal(service.match('guild', m.id).state, 'expired');
  assert.equal(service.reservation('guild', 'player-0'), undefined);
  assert.equal(service.expireConfirmations().length, 0);
});

test('partida só avança após confirmação de todos e mediador com permissão', t => {
  const { service, q } = setup(t); const m = form(service, q.id);
  assert.throws(() => service.confirm('guild', m.id, 'outsider'), code('FORBIDDEN'));
  service.confirm('guild', m.id, 'player-0');
  assert.throws(() => service.claim('guild', m.id, med), code('INVALID_STATE'));
  service.confirm('guild', m.id, 'player-1');
  assert.throws(() => service.claim('guild', m.id, outsider), code('FORBIDDEN'));
  service.claim('guild', m.id, med);
  assert.throws(() => service.claim('guild', m.id, { ...med, userId: 'other-med' }), code('INVALID_STATE'));
});

test('isolamento entre servidores e leitura de dados privados', t => {
  const { service, q } = setup(t); const m = form(service, q.id);
  assert.throws(() => service.viewMatch('guild', m.id, outsider), code('FORBIDDEN'));
  assert.throws(() => service.viewMatch('other-guild', m.id, admin), code('NOT_FOUND'));
  assert.throws(() => service.joinQueue('other-guild', q.id, 'player'), code('NOT_FOUND'));
});

test('bloqueio remove inscrição e impede entrada até liberação', t => {
  const { service, q } = setup(t); service.joinQueue('guild', q.id, 'p');
  assert.throws(() => service.blacklist('guild', med, 'p', 'Motivo registrado'), code('FORBIDDEN'));
  service.blacklist('guild', admin, 'p', 'Motivo registrado');
  assert.equal(service.reservation('guild', 'p'), undefined);
  assert.throws(() => service.joinQueue('guild', q.id, 'p'), code('BLACKLISTED'));
  service.blacklist('guild', admin, 'p', null); service.joinQueue('guild', q.id, 'p');
});

test('partida ativa exige decisão explícita antes de um bloqueio', t => {
  const { service, q } = setup(t); const m = form(service, q.id);
  assert.throws(() => service.blacklist('guild', admin, 'player-0', 'Revisão da moderação'), code('ACTIVE_MATCH'));
  service.cancel('guild', m.id, admin, 'Cancelada para revisão da moderação.');
  service.blacklist('guild', admin, 'player-0', 'Revisão da moderação');
});

test('sala manual exige mediador, estado pronto e dados válidos', t => {
  const { service, q } = setup(t); const m = ready(service, q.id);
  assert.throws(() => service.informRoom('guild', m.id, outsider, '123', 'senha'), code('FORBIDDEN'));
  assert.throws(() => service.informRoom('guild', m.id, med, '123', '||@everyone'), code('INVALID_ROOM'));
  const withRoom = service.informRoom('guild', m.id, med, '123456', 'secret');
  assert.equal(withRoom.room?.source, 'manual');
  assert.throws(() => service.informRoom('guild', m.id, med, '234567', 'secret'), code('INVALID_STATE'));
});

test('solicitações de sala simultâneas chamam o provedor uma única vez', async t => {
  const { service, q } = setup(t); const m = ready(service, q.id);
  let calls = 0; let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const provider: RoomProvider = { kind: 'external', async createRoom() { calls++; await wait; return { id: '123', password: 'secret', source: 'external' }; }, async findRoom() { return undefined; } };
  const first = service.createRoom('guild', m.id, med, provider);
  await assert.rejects(service.createRoom('guild', m.id, med, provider), code('INVALID_STATE'));
  finish(); await first;
  await service.createRoom('guild', m.id, med, provider);
  assert.equal(calls, 1);
});

test('timeout mantém pendência, bloqueia repetição e reconcilia por consulta', async t => {
  const { service, q } = setup(t); const m = ready(service, q.id);
  let calls = 0; let queries = 0;
  const provider: RoomProvider = { kind: 'external', async createRoom() { calls++; throw new Error('Connection lost after create'); }, async findRoom() { queries++; return { id: '123', password: 'secret', source: 'external' }; } };
  await assert.rejects(service.createRoom('guild', m.id, med, provider), code('ROOM_UNCERTAIN'));
  assert.equal(service.match('guild', m.id).state, 'room_pending');
  assert.throws(() => service.cancel('guild', m.id, admin, 'Cancelar após erro'), code('INVALID_STATE'));
  await assert.rejects(service.createRoom('guild', m.id, med, provider), code('INVALID_STATE'));
  await assert.rejects(service.reconcileRoom('guild', m.id, new SimulatedRoomProvider()), code('PROVIDER_MISMATCH'));
  const result = await service.reconcileRoom('guild', m.id, provider);
  assert.equal(result.state, 'room_created'); assert.equal(calls, 1); assert.equal(queries, 1);
});

test('falha definitivamente sem sala permite uma tentativa futura', async t => {
  const { service, q } = setup(t); const m = ready(service, q.id);
  const provider: RoomProvider = { kind: 'external', async createRoom() { throw new RoomNotCreatedError('Sem créditos; sala não criada.'); }, async findRoom() { return undefined; } };
  await assert.rejects(service.createRoom('guild', m.id, med, provider), code('ROOM_NOT_CREATED'));
  assert.equal(service.match('guild', m.id).state, 'ready');
});

test('resultado exige placar coerente e confirmações dos dois representantes', t => {
  const { service, q } = setup(t); const m = playing(service, q.id);
  assert.throws(() => service.proposeResult('guild', m.id, med, 2, '7x3'), code('INVALID_SCORE'));
  service.proposeResult('guild', m.id, med, 1, '7x3');
  assert.throws(() => service.acceptResult('guild', m.id, 'outsider'), code('FORBIDDEN'));
  service.acceptResult('guild', m.id, 'player-0');
  assert.equal(service.ranking('guild').length, 0);
  service.acceptResult('guild', m.id, 'player-1'); service.acceptResult('guild', m.id, 'player-1');
  assert.deepEqual(service.ranking('guild'), [{ userId: 'player-0', wins: 1, losses: 0 }, { userId: 'player-1', wins: 0, losses: 1 }]);
  assert.equal(service.reservation('guild', 'player-0'), undefined);
});

test('disputa só pode ser resolvida por moderação, preservando a proposta e a justificativa', t => {
  const { service, q, store } = setup(t); const m = playing(service, q.id);
  service.proposeResult('guild', m.id, med, 1, '7x3');
  service.dispute('guild', m.id, 'player-1', 'Resultado está incorreto.');
  assert.throws(() => service.resolve('guild', m.id, med, 2, 'Vídeo conferido.'), code('FORBIDDEN'));
  const result = service.resolve('guild', m.id, admin, 2, 'Vídeo conferido.');
  assert.equal(result.result?.winner, 1); assert.equal(result.result?.decision?.winner, 2);
  assert.equal(service.ranking('guild')[0]?.userId, 'player-1');
  const events = store.db.prepare('SELECT details FROM audit WHERE action=?').all('result_disputed') as { details: string }[];
  assert.equal(JSON.parse(events[0]!.details).reason, 'Resultado está incorreto.');
});

test('banco reaberto preserva reserva, confirmação, canal e ranking', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bot.sqlite'); let store = new Store(file); let service = new BotService(store);
  service.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med' }, admin);
  const q = service.createQueue('guild', admin, 1, 'mobile', 'Persistência após reinício.');
  const m = form(service, q.id); service.confirm('guild', m.id, 'player-0'); service.attachChannel('guild', m.id, 'channel', 'message');
  store.close(); store = new Store(file); service = new BotService(store);
  assert.equal(service.match('guild', m.id).players[0]?.confirmed, true);
  assert.equal(service.match('guild', m.id).channelId, 'channel');
  assert.equal(service.reservation('guild', 'player-0')?.match_id, m.id);
  service.confirm('guild', m.id, 'player-1'); service.claim('guild', m.id, med);
  service.informRoom('guild', m.id, med, '123', 'secret'); service.startMatch('guild', m.id, med);
  service.proposeResult('guild', m.id, med, 1, '7x3');
  service.acceptResult('guild', m.id, 'player-0'); service.acceptResult('guild', m.id, 'player-1');
  store.close(); store = new Store(file); service = new BotService(store);
  try { assert.equal(service.ranking('guild')[0]?.wins, 1); } finally { store.close(); }
});

test('segredos de sala não entram na auditoria e a simulação é identificada', async t => {
  const { service, q, store } = setup(t); const m = ready(service, q.id);
  const result = await service.createRoom('guild', m.id, med, new SimulatedRoomProvider());
  const fields = matchEmbed(result).toJSON().fields!;
  assert.ok(fields.some(f => f.name.includes('SIMULAÇÃO')));
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM audit').all()).includes('DEMO'));
});

test('valores são inteiros em centavos e configuração inválida falha cedo', () => {
  assert.equal(parseMoney('0,29'), 29); assert.equal(parseMoney('2.50'), 250);
  for (const value of ['1.001', '-1', 'NaN', '1e4']) assert.throws(() => parseMoney(value));
  assert.throws(() => loadConfig({ ROOM_MODE: 'real' }), code('CONFIG'));
  assert.throws(() => loadConfig({ CONFIRMATION_TIMEOUT_SECONDS: 'NaN' }), code('CONFIG'));
  assert.throws(() => requireDiscord(loadConfig({})), code('CONFIG'));
});

test('comandos slash serializam e possuem nomes únicos', () => {
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length);
  assert.ok(commands.some(c => c.name === 'configurar'));
  assert.ok(commands.some(c => c.name === 'sala'));
});

test('conexões SQLite concorrentes preservam uma única partida e duas reservas', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-workers-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'bot.sqlite'); const store = new Store(filename); t.after(() => store.close());
  const service = new BotService(store);
  service.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med' }, admin);
  const q = service.createQueue('guild', admin, 1, 'mobile', 'Concorrência entre conexões independentes.');
  const outcomes = await Promise.all(['a', 'b', 'a', 'b', 'a', 'b'].map(user => new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('./fixtures/queue-worker.js', import.meta.url), { workerData: { filename, queueId: q.id, user } });
    let result = '';
    worker.on('message', value => { result = String(value); });
    worker.on('error', reject);
    worker.on('exit', status => status === 0 ? resolve(result) : reject(new Error(`Worker exited ${status}`)));
  })));
  assert.ok(outcomes.every(o => o === 'joined' || o === 'ALREADY_ACTIVE'));
  assert.equal(service.matches('guild').length, 1);
  assert.equal(service.matches('guild')[0]?.players.length, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM reservations').get()?.count, 2);
});
