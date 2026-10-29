import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { DomainError } from '../src/domain.js';
import {
  MercadoPagoPixProvider, MercadoPagoProviderError, parseMercadoPagoWebhookRequest, verifyMercadoPagoWebhook,
} from '../src/payment-providers/mercadopago.js';

const ACCESS = 'FAKE-ACCESS-TOKEN-ONLY-FOR-LOCAL-TESTS';
const SECRET = 'FAKE-WEBHOOK-SECRET-ONLY-FOR-LOCAL-TESTS';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4aUAAAAASUVORK5CYII=';
const input = { reference: 'internal-match-player-reference', idempotencyKey: 'persisted-operation-key-0001', amountCents: 123, payerEmail: 'payer@example.test' };
const NOW = 1_798_000_000_000;
const validPayload = () => ({
  id: 12345, status: 'pending', currency_id: 'BRL', payment_method_id: 'pix',
  transaction_amount: 1.23, transaction_amount_refunded: 0, external_reference: input.reference,
  date_of_expiration: '2026-10-25T20:00:00.000Z',
  point_of_interaction: { transaction_data: { qr_code: '000201-PUBLIC-PIX-CODE-FIXTURE', qr_code_base64: PNG } },
});
const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
async function endpoint(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => { response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
function json(response: ServerResponse, payload: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); }
function signed(timestamp = String(Math.floor(NOW / 1000)), paymentId = '12345', requestId = 'request-123') {
  const signature = createHmac('sha256', SECRET).update(`id:${paymentId};request-id:${requestId};ts:${timestamp};`).digest('hex');
  return { signature: `ts=${timestamp},v1=${signature}`, requestId, dataId: paymentId };
}

test('criação PIX segue Payments API e reutiliza a chave persistida sem retry automático', async t => {
  let calls = 0;
  const url = await endpoint(t, async (req, res) => {
    calls++; assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/payments');
    assert.equal(req.headers.authorization, `Bearer ${ACCESS}`); assert.equal(req.headers['x-idempotency-key'], input.idempotencyKey);
    const data = await body(req);
    assert.equal(data.transaction_amount, 1.23); assert.equal(data.payment_method_id, 'pix');
    assert.equal(data.external_reference, input.reference); assert.deepEqual(data.payer, { email: input.payerEmail });
    json(res, validPayload());
  });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  const result = await provider.createPix(input);
  assert.equal(result.id, '12345'); assert.equal(result.amountCents, 123); assert.equal(result.status, 'pending');
  assert.equal(result.qrCode, PNG); assert.equal(result.pixCopyPaste, '000201-PUBLIC-PIX-CODE-FIXTURE');
  assert.equal(calls, 1);
});

test('consulta canônica valida ID, PIX, BRL e centavos sem usar e-mail como confirmação', async t => {
  const url = await endpoint(t, (req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/payments/12345');
    json(res, { ...validPayload(), transaction_amount: 0.29, payer: { email: 'approved@example.test' }, status: 'pending' });
  });
  const result = await new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url }).getPayment('12345');
  assert.equal(result.amountCents, 29); assert.equal(result.status, 'pending');
  assert.ok(!JSON.stringify(result).includes('approved@example.test'));
});

test('estorno parcial é preservado e status desconhecido não vira aprovação', async t => {
  let calls = 0;
  const url = await endpoint(t, (_req, res) => json(res, { ...validPayload(), status: calls++ === 0 ? 'approved' : 'charged_back', transaction_amount_refunded: 0.5 }));
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  const partial = await provider.getPayment('12345');
  assert.equal(partial.status, 'approved'); assert.equal(partial.refundedCents, 50);
  assert.equal((await provider.getPayment('12345')).status, 'unknown');
});

test('redirect não encaminha credenciais a outro destino', async t => {
  let sinkCalls = 0; let calls = 0;
  const sink = await endpoint(t, (_req, res) => { sinkCalls++; json(res, validPayload()); });
  const url = await endpoint(t, (_req, res) => { calls++; res.writeHead(307, { Location: sink }); res.end(); });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  await assert.rejects(provider.createPix(input), isCode('PAYMENT_WRITE_UNCERTAIN'));
  assert.equal(calls, 1); assert.equal(sinkCalls, 0);
});

test('5xx e corpos que ecoam segredos não geram retry nem vazam a resposta', async t => {
  let calls = 0;
  const url = await endpoint(t, (_req, res) => { calls++; json(res, { token: ACCESS, secret: SECRET }, 503); });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, webhookSecret: SECRET, testBaseUrl: url });
  await assert.rejects(provider.createPix(input), error => {
    assert.ok(error instanceof MercadoPagoProviderError); assert.equal(error.outcome, 'unknown');
    assert.ok(!`${inspect(error)}${JSON.stringify(error)}`.includes(ACCESS)); return true;
  });
  assert.equal(calls, 1);
  assert.ok(!`${inspect(provider)}${JSON.stringify(provider)}`.includes(ACCESS));
  assert.ok(!`${inspect(provider)}${JSON.stringify(provider)}`.includes(SECRET));
});

test('rejeição de validação é distinta de timeout incerto', async t => {
  const rejectedUrl = await endpoint(t, (_req, res) => json(res, { message: ACCESS }, 422));
  await assert.rejects(new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: rejectedUrl }).createPix(input), error => error instanceof MercadoPagoProviderError && error.code === 'PAYMENT_NOT_CREATED' && error.outcome === 'not_created');
  let calls = 0;
  const timeoutUrl = await endpoint(t, () => { calls++; });
  await assert.rejects(new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: timeoutUrl, timeoutMs: 100 }).createPix(input), isCode('PAYMENT_WRITE_UNCERTAIN'));
  assert.equal(calls, 1);
});

test('contrato inválido após criação permanece incerto sem repetir POST', async t => {
  let calls = 0;
  const url = await endpoint(t, (_req, res) => { calls++; json(res, { ...validPayload(), external_reference: 'another-charge' }); });
  await assert.rejects(new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url }).createPix(input), isCode('PAYMENT_WRITE_UNCERTAIN'));
  assert.equal(calls, 1);
});

test('consulta rejeita dinheiro com frações de centavo, outra moeda, cartão e ID trocado', async t => {
  const variants = [
    { transaction_amount: 1.001 }, { currency_id: 'USD' }, { payment_method_id: 'visa' }, { id: 54321 },
    { id: Number.MAX_SAFE_INTEGER + 1 }, { transaction_amount_refunded: 2 },
  ];
  let n = 0;
  const url = await endpoint(t, (_req, res) => json(res, { ...validPayload(), ...variants[n++] }));
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  for (const _variant of variants) await assert.rejects(provider.getPayment('12345'), isCode('PAYMENT_READ_FAILED'));
});

test('respostas excessivas, JSON inválido e QR não PNG são rejeitados', async t => {
  let mode = 0;
  const url = await endpoint(t, (_req, res) => {
    if (mode++ === 0) { res.writeHead(200, { 'Content-Length': 2_000_000 }); res.end('x'); }
    else if (mode === 2) res.end('{bad-json');
    else json(res, { ...validPayload(), point_of_interaction: { transaction_data: { qr_code_base64: Buffer.from('<script>unsafe</script>').toString('base64') } } });
  });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  for (let i = 0; i < 3; i++) await assert.rejects(provider.getPayment('12345'), isCode('PAYMENT_READ_FAILED'));
});

test('endpoints de teste são restritos a loopback literal e entrada inválida não faz chamada', async t => {
  for (const url of ['https://api.evil.test', 'http://example.com', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://user:pass@127.0.0.1:1234']) {
    assert.throws(() => new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url }), isCode('MP_CONFIG'));
  }
  let calls = 0;
  const url = await endpoint(t, (_req, res) => { calls++; json(res, validPayload()); });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  await assert.rejects(provider.createPix({ ...input, amountCents: 1.2 }), isCode('MP_INVALID_AMOUNT'));
  await assert.rejects(provider.createPix({ ...input, payerEmail: 'invalid' }), isCode('MP_INVALID_PAYER'));
  await assert.rejects(provider.getPayment('../123'), isCode('MP_INVALID_PAYMENT_ID'));
  assert.equal(calls, 0);
});

test('estorno integral consulta antes e envia corpo vazio com chave persistida', async t => {
  const calls: string[] = [];
  const url = await endpoint(t, async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'GET') json(res, { ...validPayload(), status: 'approved' });
    else {
      assert.equal(req.headers['x-idempotency-key'], 'refund-stable-key-001'); assert.deepEqual(await body(req), {});
      json(res, { id: 999, payment_id: 12345, amount: 1.23, status: 'approved' });
    }
  });
  const result = await new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url }).refundPayment('12345', 'refund-stable-key-001');
  assert.deepEqual(result, { id: '999', paymentId: '12345', amountCents: 123, status: 'approved' });
  assert.deepEqual(calls, ['GET /v1/payments/12345', 'POST /v1/payments/12345/refunds']);
});

test('pagamento com estorno anterior exige reconciliação e não repete saída', async t => {
  let writes = 0;
  const url = await endpoint(t, (req, res) => { if (req.method === 'POST') writes++; json(res, { ...validPayload(), status: 'approved', transaction_amount_refunded: 0.5 }); });
  await assert.rejects(new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url }).refundPayment('12345', 'refund-stable-key-001'), isCode('MP_NOT_REFUNDABLE'));
  assert.equal(writes, 0);
});

test('busca por referência recupera ID com consulta canônica e recusa ambiguidades', async t => {
  let mode: 'one' | 'none' | 'many' = 'one'; const methods: string[] = [];
  const url = await endpoint(t, (req, res) => {
    methods.push(req.method!);
    if (req.url?.startsWith('/v1/payments/search?')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      assert.equal(query.get('external_reference'), input.reference);
      if (mode === 'none') json(res, { paging: { total: 0 }, results: [] });
      else if (mode === 'many') json(res, { paging: { total: 2 }, results: [{ id: '12345', external_reference: input.reference }, { id: '99999', external_reference: input.reference }] });
      else json(res, { paging: { total: 1 }, results: [{ id: '12345', external_reference: input.reference }] });
    } else json(res, { ...validPayload(), status: 'approved' });
  });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, testBaseUrl: url });
  assert.equal((await provider.findPaymentByReference(input.reference))?.status, 'approved');
  mode = 'none'; assert.equal(await provider.findPaymentByReference(input.reference), undefined);
  mode = 'many'; await assert.rejects(provider.findPaymentByReference(input.reference), isCode('PAYMENT_LOOKUP_AMBIGUOUS'));
  assert.ok(methods.every(m => m === 'GET'));
});

test('HMAC oficial valida valores vinculados e timestamps em segundos ou legado ms', () => {
  assert.equal(verifyMercadoPagoWebhook({ ...signed(), secret: SECRET, now: () => NOW }).paymentId, '12345');
  assert.equal(verifyMercadoPagoWebhook({ ...signed(String(NOW)), secret: SECRET, now: () => NOW }).paymentId, '12345');
  for (const update of [{ requestId: 'another-request' }, { dataId: '54321' }, { signature: signed().signature.replace(/v1=./, 'v1=z') }]) {
    assert.throws(() => verifyMercadoPagoWebhook({ ...signed(), ...update, secret: SECRET, now: () => NOW }), isCode('MP_INVALID_WEBHOOK'));
  }
  assert.throws(() => verifyMercadoPagoWebhook({ ...signed(), secret: 'different-secret-1234567', now: () => NOW }), isCode('MP_INVALID_WEBHOOK'));
});

test('notificações fora da janela e cabeçalhos duplicados são recusados', () => {
  for (const timestamp of [String(Math.floor(NOW / 1000) - 301), String(Math.floor(NOW / 1000) + 301)]) {
    assert.throws(() => verifyMercadoPagoWebhook({ ...signed(timestamp), secret: SECRET, now: () => NOW }), isCode('MP_INVALID_WEBHOOK'));
  }
  const valid = signed();
  for (const signature of [[valid.signature], `${valid.signature},${valid.signature}`, `${valid.signature},v1=${'0'.repeat(64)}`]) {
    assert.throws(() => verifyMercadoPagoWebhook({ ...valid, signature, secret: SECRET, now: () => NOW }), isCode('MP_INVALID_WEBHOOK'));
  }
  const headers = ['x-signature', valid.signature, 'x-request-id', valid.requestId];
  assert.deepEqual(parseMercadoPagoWebhookRequest(headers, '/hooks?data.id=12345'), valid);
  assert.throws(() => parseMercadoPagoWebhookRequest([...headers, 'X-Request-Id', 'duplicate'], '/hooks?data.id=12345'), isCode('MP_INVALID_WEBHOOK'));
  assert.throws(() => parseMercadoPagoWebhookRequest(headers, '/hooks?data.id=12345&data%2Eid=12345'), isCode('MP_INVALID_WEBHOOK'));
});

test('webhook assinado consulta recurso canônico sem confiar no corpo notificado', async t => {
  let calls = 0;
  const url = await endpoint(t, (req, res) => { calls++; assert.equal(req.method, 'GET'); json(res, { ...validPayload(), status: 'pending' }); });
  const provider = new MercadoPagoPixProvider({ accessToken: ACCESS, webhookSecret: SECRET, testBaseUrl: url, now: () => NOW });
  const notified = { ...signed(), body: { status: 'approved', payer: { email: 'approved@example.test' } } };
  const result = await provider.canonicalPaymentFromWebhook(notified);
  assert.equal(result.status, 'pending'); assert.equal(calls, 1);
  await assert.rejects(provider.canonicalPaymentFromWebhook({ ...signed(), requestId: 'tampered' }), isCode('MP_INVALID_WEBHOOK'));
  assert.equal(calls, 1);
});
