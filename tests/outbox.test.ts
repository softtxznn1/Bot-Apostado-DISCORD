import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/database.js';
import { DurableOutbox, type JsonValue } from '../src/outbox.js';

function setup(t: TestContext, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let clock = 1000;
  const outbox = new DurableOutbox(store, { now: () => clock, ...options });
  return { store, outbox, advance: (ms: number) => { clock += ms; } };
}

test('outbox deduplica payload canônico e não repete um efeito concluído', t => {
  const { outbox } = setup(t);
  outbox.enqueue('match:1', 'match.sync', { guild: 'g', version: 1 });
  outbox.enqueue('match:1', 'match.sync', { version: 1, guild: 'g' });
  assert.equal(outbox.get('match:1')?.revision, 1);
  const job = outbox.claim('worker', 1000)!;
  assert.equal(outbox.complete('worker', job), true);
  outbox.enqueue('match:1', 'match.sync', { guild: 'g', version: 1 });
  assert.equal(outbox.claim('worker', 1000), undefined);
  assert.deepEqual(outbox.stats(), { pending: 0, running: 0, done: 1, dead: 0 });
  assert.throws(() => outbox.enqueue('match:1', 'payment.send', {}));
});

test('outbox participa da transação de negócio e acompanha rollback', t => {
  const { store, outbox } = setup(t);
  assert.throws(() => store.transaction(() => {
    outbox.enqueue('rollback', 'match.sync', { id: '1' });
    throw new Error('Business transaction rolled back');
  }));
  assert.equal(outbox.get('rollback'), undefined);
  store.transaction(() => { outbox.enqueue('committed', 'match.sync', { id: '2' }); });
  assert.equal(outbox.get('committed')?.state, 'pending');
});

test('lease impede dois executores e bloqueia conclusão tardia mesmo com owner reutilizado', t => {
  const { outbox, advance } = setup(t);
  outbox.enqueue('match:1', 'match.sync', {});
  const first = outbox.claim('worker', 100)!;
  assert.equal(outbox.claim('other-worker', 100), undefined);
  assert.equal(outbox.complete('other-worker', first), false);
  advance(100);
  assert.equal(outbox.complete('worker', first), false);
  const second = outbox.claim('worker', 100)!;
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(outbox.complete('worker', first), false);
  assert.equal(outbox.fail('worker', first, 'STALE_FAILURE'), false);
  assert.equal(outbox.complete('worker', second), true);
});

test('atualização durante execução preserva a nova revisão para uma próxima entrega', t => {
  const { outbox } = setup(t);
  outbox.enqueue('match:1', 'match.sync', { version: 1 });
  const first = outbox.claim('worker', 1000)!;
  outbox.enqueue('match:1', 'match.sync', { version: 2 });
  assert.equal(outbox.get('match:1')?.state, 'running');
  assert.deepEqual(first.payload, { version: 1 });
  assert.equal(outbox.complete('worker', first), true);
  assert.equal(outbox.get('match:1')?.state, 'pending');
  const second = outbox.claim('other-worker', 1000)!;
  assert.equal(second.revision, 2); assert.equal(second.attempt, 1);
  assert.deepEqual(second.payload, { version: 2 });
  outbox.complete('other-worker', second);
  assert.equal(outbox.get('match:1')?.state, 'done');
});

test('falha da versão anterior não atrasa nem mata uma revisão nova', t => {
  const { outbox } = setup(t, { maxAttempts: 1 });
  outbox.enqueue('match:1', 'match.sync', { version: 1 });
  const job = outbox.claim('worker', 1000)!;
  outbox.enqueue('match:1', 'match.sync', { version: 2 });
  outbox.fail('worker', job, 'HTTP_FAILURE');
  const next = outbox.claim('worker', 1000)!;
  assert.equal(next.revision, 2); assert.equal(next.attempt, 1);
  assert.equal(outbox.get('match:1')?.lastError, null);
});

test('falhas usam backoff e limite; repetição morta exige ação explícita', t => {
  const { outbox, advance } = setup(t, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 });
  outbox.enqueue('match:1', 'match.sync', {});
  let job = outbox.claim('worker', 1000)!;
  outbox.fail('worker', job, 'HTTP_FAILURE');
  assert.equal(outbox.get('match:1')?.availableAt, 1100);
  assert.equal(outbox.claim('worker', 1000), undefined);
  advance(100); job = outbox.claim('worker', 1000)!;
  outbox.fail('worker', job, 'HTTP_FAILURE');
  assert.equal(outbox.get('match:1')?.availableAt, 1300);
  advance(200); job = outbox.claim('worker', 1000)!;
  outbox.fail('worker', job, 'HTTP_FAILURE');
  assert.equal(outbox.get('match:1')?.state, 'dead');
  assert.equal(outbox.claim('worker', 1000), undefined);
  assert.equal(outbox.retryDead('match:1'), true);
  job = outbox.claim('worker', 1000)!;
  assert.equal(job.attempt, 1); assert.equal(job.revision, 2);
});

test('leases abandonados respeitam limite de tentativas e não perdem nova revisão', t => {
  const { outbox, advance } = setup(t, { maxAttempts: 1 });
  outbox.enqueue('old', 'match.sync', {});
  outbox.claim('worker', 100); advance(100);
  assert.equal(outbox.claim('worker', 100), undefined);
  assert.equal(outbox.get('old')?.state, 'dead');
  outbox.enqueue('new', 'match.sync', { version: 1 });
  outbox.claim('worker', 100);
  outbox.enqueue('new', 'match.sync', { version: 2 }); advance(100);
  const recovered = outbox.claim('other', 100)!;
  assert.equal(recovered.key, 'new'); assert.equal(recovered.revision, 2); assert.equal(recovered.attempt, 1);
});

test('outbox reaparece após reabrir SQLite e retoma somente após vencer a lease', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-outbox-'));
  const filename = join(dir, 'bot.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1000;
  let store = new Store(filename);
  let outbox = new DurableOutbox(store, { now: () => clock });
  outbox.enqueue('match:1', 'match.sync', { version: 1 });
  const first = outbox.claim('old-process', 100)!;
  store.close(); store = new Store(filename);
  t.after(() => store.close());
  outbox = new DurableOutbox(store, { now: () => clock });
  assert.equal(outbox.claim('new-process', 100), undefined);
  clock += 100;
  const recovered = outbox.claim('new-process', 100)!;
  assert.equal(recovered.attempt, 2);
  assert.equal(outbox.complete('old-process', first), false);
  assert.equal(outbox.complete('new-process', recovered), true);
});

test('payload inválido é recusado e exceções arbitrárias não viram dados de erro persistidos', t => {
  const { outbox } = setup(t);
  assert.throws(() => outbox.enqueue('bad', 'match.sync', { value: undefined } as unknown as JsonValue));
  assert.throws(() => outbox.enqueue('bad', 'match.sync', { value: NaN }));
  assert.throws(() => outbox.enqueue('bad', 'match.sync', { value: 'x'.repeat(70_000) }));
  outbox.enqueue('good', 'match.sync', {});
  const job = outbox.claim('worker', 1000)!;
  outbox.fail('worker', job, 'https://example.com/private?token=secret');
  assert.equal(outbox.get('good')?.lastError, 'JOB_FAILED');
});
