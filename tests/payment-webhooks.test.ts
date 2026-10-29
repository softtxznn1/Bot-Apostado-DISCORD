import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPaymentWebhookServer } from '../src/payment-webhooks.js';
import { verifyMercadoPagoWebhook } from '../src/payment-providers/mercadopago.js';
import type { PixPayment } from '../src/payment-providers/types.js';

const secret = 'test-webhook-secret-not-a-real-key';
async function fixture(t: TestContext, options: { callbackFailsOnce?: boolean; rateLimit?: number } = {}) {
  let queries = 0; let callbacks = 0;
  const values: PixPayment[] = [];
  const server = createPaymentWebhookServer({ rateLimit: options.rateLimit,
    mercadoPago: {
      verifyWebhook: input => verifyMercadoPagoWebhook({ ...input, secret }),
      canonicalPaymentFromWebhook: async input => {
        queries++; const verified = verifyMercadoPagoWebhook({ ...input, secret });
        return { id: verified.paymentId, status: 'pending', amountCents: 100, externalReference: 'canonical-reference', refundedCents: 0 };
      },
    },
    onMercadoPagoPayment: async payment => {
      callbacks++;
      if (options.callbackFailsOnce && callbacks === 1) throw new Error('sensitive internal failure');
      values.push(payment);
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const timestamp = String(Math.floor(Date.now() / 1000)); const requestId = 'webhook-request';
  const signature = `ts=${timestamp},v1=${createHmac('sha256', secret).update(`id:123;request-id:${requestId};ts:${timestamp};`).digest('hex')}`;
  const headers = { 'content-type': 'application/json', 'x-signature': signature, 'x-request-id': requestId };
  const send = (body = '{}', overrides: Record<string, string> = {}) => fetch(`${base}/webhooks/mercadopago?data.id=123`, { method: 'POST', headers: { ...headers, ...overrides }, body });
  return { base, headers, send, values, queries: () => queries, callbacks: () => callbacks };
}

test('assinatura inválida nunca consulta banco nem aceita status do corpo', async t => {
  const f = await fixture(t);
  const response = await f.send('{"status":"approved"}', { 'x-signature': 'ts=1,v1=bad' });
  assert.equal(response.status, 401); assert.equal(f.queries(), 0); assert.equal(f.callbacks(), 0);
});
test('assinatura válida usa somente o pagamento canônico e deduplica repetições', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('{"status":"approved","amount":999999}')).status, 200);
  assert.equal(f.values[0]?.status, 'pending');
  assert.equal((await f.send()).status, 200); assert.equal(f.queries(), 1); assert.equal(f.callbacks(), 1);
});
test('falha de conciliação permite retentativa sem vazar erro interno', async t => {
  const f = await fixture(t, { callbackFailsOnce: true });
  const first = await f.send(); assert.equal(first.status, 503); assert.ok(!(await first.text()).includes('sensitive'));
  assert.equal((await f.send()).status, 200); assert.equal(f.queries(), 2); assert.equal(f.values.length, 1);
});
test('consultas duplicadas em execução compartilham um processamento', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.send(), f.send(), f.send()]);
  assert.ok(responses.every(r => r.status === 200)); assert.equal(f.callbacks(), 1);
});
test('corpo inválido, query duplicada e corpo excessivo são recusados antes do GET', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('not-json')).status, 400);
  assert.equal((await f.send('x'.repeat(17_000))).status, 413);
  assert.equal((await fetch(`${f.base}/webhooks/mercadopago?data.id=123&data.id=123`, { method: 'POST', headers: f.headers, body: '{}' })).status, 400);
  assert.equal(f.queries(), 0);
});
test('webhook exige método, tipo e rota corretos e limita frequência', async t => {
  const f = await fixture(t, { rateLimit: 1 });
  assert.equal((await fetch(`${f.base}/webhooks/mercadopago?data.id=123`)).status, 405);
  assert.equal((await fetch(`${f.base}/unknown`)).status, 404);
  assert.equal((await f.send()).status, 200);
  const limited = await f.send(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
});
