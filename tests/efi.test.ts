import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpsRequest } from 'node:https';
import { DomainError } from '../src/domain.js';
import {
  EfiHttpError, EfiPixProvider, buildEfiHttpsAgent,
  type EfiHttpRequest, type EfiHttpResponse, type EfiPixConfig, type EfiTransport,
} from '../src/payment-providers/efi.js';

const id = 'a'.repeat(32);
const receipt = 'E' + '1'.repeat(31);
const clock = Date.UTC(2026, 9, 25, 12);
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
const config: EfiPixConfig = {
  clientId: 'unit-test-client', clientSecret: 'unit-test-secret', pixKey: 'unit-test-pix-key',
  certFile: '/test-fixture/cert-not-used-by-injected-transport.p12', sandbox: true,
};
const input = { reference: id, idempotencyKey: 'unit-operation-key', amountCents: 1000, payerEmail: 'discarded@example.test', description: 'Cobrança de teste' };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const charge = (change: Record<string, unknown> = {}) => ({
  txid: id, status: 'ATIVA', valor: { original: '10.00' },
  calendario: { criacao: new Date(clock).toISOString(), expiracao: 3600 },
  loc: { id: 42 }, pixCopiaECola: '000201-CODIGO-SIMULADO-NAO-PAGAVEL', ...change,
});
function fixture(handler?: (request: EfiHttpRequest) => EfiHttpResponse | Promise<EfiHttpResponse>, now: () => number = () => clock) {
  const calls: EfiHttpRequest[] = [];
  const transport: EfiTransport = async request => {
    calls.push(request);
    if (request.url.pathname === '/oauth/token') return { status: 200, body: { access_token: 'unit-test-access-token', token_type: 'Bearer', expires_in: 60 } };
    return handler ? handler(request) : { status: 200, body: charge() };
  };
  return { provider: new EfiPixProvider(config, { transport, now }), calls };
}

test('Efí usa os hosts oficiais e autenticação OAuth JSON via Basic', async () => {
  const f = fixture(request => request.url.pathname.includes('/loc/')
    ? { status: 200, body: { qrcode: '000201-CODIGO-SIMULADO-NAO-PAGAVEL', imagemQrcode: `data:image/png;base64,${image}` } }
    : { status: 200, body: charge() });
  const payment = await f.provider.getPayment(id);
  assert.equal(payment.id, id); assert.equal(payment.externalReference, id);
  assert.equal(payment.status, 'pending'); assert.equal(payment.qrCode, image);
  assert.ok(f.calls.every(c => c.url.origin === 'https://pix-h.api.efipay.com.br'));
  const oauth = f.calls[0]!;
  assert.equal(oauth.method, 'POST'); assert.deepEqual(JSON.parse(oauth.body!), { grant_type: 'client_credentials' });
  assert.ok(oauth.headers.Authorization?.startsWith('Basic '));
  assert.ok(f.calls[1]?.headers.Authorization?.startsWith('Bearer '));
  assert.ok(f.calls.every(c => c.maxResponseBytes === 1_048_576 && c.timeoutMs === 15_000));
  assert.ok(!JSON.stringify(f.provider).includes('unit-test-secret'));
  assert.ok(!JSON.stringify(f.provider).includes('unit-test-access-token'));
  const productionCalls: string[] = [];
  const production = new EfiPixProvider({ ...config, sandbox: false }, { transport: async r => {
    productionCalls.push(r.url.origin);
    return r.url.pathname === '/oauth/token' ? { status: 200, body: { access_token: 'unit-test-token', expires_in: 60 } } : { status: 200, body: charge({ status: 'REMOVIDA_PELO_PSP' }) };
  }, now: () => clock });
  await production.getPayment(id);
  assert.ok(productionCalls.every(origin => origin === 'https://pix.api.efipay.com.br'));
});

test('criação usa PUT com txid estável, mínimo de dados pessoais e não duplica cobrança existente', async () => {
  let exists = false;
  const f = fixture(request => {
    if (request.url.pathname.includes('/loc/')) return { status: 200, body: { qrcode: '000201-CODIGO-SIMULADO-NAO-PAGAVEL' } };
    if (request.method === 'GET') return exists ? { status: 200, body: charge() } : { status: 404, body: {} };
    exists = true;
    assert.equal(request.method, 'PUT'); assert.equal(request.url.pathname, `/v2/cob/${id}`);
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    assert.deepEqual(body.valor, { original: '10.00' }); assert.equal(body.chave, config.pixKey);
    assert.ok(!('devedor' in body)); assert.ok(!JSON.stringify(body).includes(input.payerEmail));
    return { status: 201, body: charge() };
  });
  await f.provider.createPix(input); await f.provider.createPix(input);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.provider.txidFor(id), id);
  await assert.rejects(f.provider.createPix({ ...input, amountCents: 500 }), code('EFI_IDEMPOTENCY_CONFLICT'));
});

test('token em cache é compartilhado e expira antes da validade do servidor', async () => {
  let now = clock;
  const f = fixture(() => ({ status: 200, body: charge({ status: 'REMOVIDA_PELO_PSP' }) }), () => now);
  await Promise.all([f.provider.getPayment(id), f.provider.getPayment(id)]);
  assert.equal(f.calls.filter(c => c.url.pathname === '/oauth/token').length, 1);
  now += 55_000;
  await f.provider.getPayment(id);
  assert.equal(f.calls.filter(c => c.url.pathname === '/oauth/token').length, 2);
});

test('401 invalida o token sem repetir a requisição de escrita automaticamente', async () => {
  const f = fixture(request => request.method === 'GET' ? { status: 404, body: {} } : { status: 401, body: { message: 'not exposed' } });
  await assert.rejects(f.provider.createPix(input), error => error instanceof EfiHttpError && error.status === 401);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  await assert.rejects(f.provider.getPayment(id), error => error instanceof EfiHttpError && error.status === 404);
  assert.equal(f.calls.filter(c => c.url.pathname === '/oauth/token').length, 2);
});

test('falha após PUT fica incerta, sem retentativa ou vazamento do erro de transporte', async () => {
  const f = fixture(request => {
    if (request.method === 'GET') return { status: 404, body: {} };
    throw new Error('unit-test-secret must never be included in errors');
  });
  await assert.rejects(f.provider.createPix(input), error => error instanceof DomainError && error.code === 'EFI_CONNECTION' && !error.message.includes(config.clientSecret));
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('status concluída exige recebimento canônico com referência e soma exatas', async () => {
  const valid = { endToEndId: receipt, txid: id, valor: '10.00' };
  for (const [pix, expected] of [[undefined, 'unknown'], [[{ ...valid, valor: '9.00' }], 'unknown'], [[valid], 'approved']] as const) {
    const f = fixture(() => ({ status: 200, body: charge({ status: 'CONCLUIDA', pix }) }));
    assert.equal((await f.provider.getPayment(id)).status, expected);
  }
  const wrong = fixture(() => ({ status: 200, body: charge({ status: 'CONCLUIDA', pix: [{ ...valid, txid: 'b'.repeat(32) }] }) }));
  await assert.rejects(wrong.provider.getPayment(id), code('EFI_INVALID_RECEIPT'));
  const duplicate = fixture(() => ({ status: 200, body: charge({ status: 'CONCLUIDA', pix: [valid, valid] }) }));
  await assert.rejects(duplicate.provider.getPayment(id), code('EFI_INVALID_RECEIPT'));
});

test('expiração, cancelamento e devoluções canônicas são normalizados sem confiança em notificações', async () => {
  const expired = fixture(() => ({ status: 200, body: charge() }), () => clock + 3_600_001);
  assert.equal((await expired.provider.getPayment(id)).status, 'expired');
  const cancelled = fixture(() => ({ status: 200, body: charge({ status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }) }));
  assert.equal((await cancelled.provider.getPayment(id)).status, 'cancelled');
  for (const [value, expected] of [['5.00', 'unknown'], ['10.00', 'refunded']] as const) {
    const f = fixture(() => ({ status: 200, body: charge({ status: 'CONCLUIDA', pix: [{ endToEndId: receipt, txid: id, valor: '10.00', devolucoes: [{ id: 'refund1', status: 'DEVOLVIDO', valor: value }] }] }) }));
    const payment = await f.provider.getPayment(id);
    assert.equal(payment.status, expected); assert.equal(payment.refundedCents, value === '5.00' ? 500 : 1000);
  }
});

test('dados monetários ou referências inesperadas nunca se tornam aprovação', async () => {
  const badAmount = fixture(() => ({ status: 200, body: charge({ valor: { original: '1e2' } }) }));
  await assert.rejects(badAmount.provider.getPayment(id), code('EFI_INVALID_AMOUNT'));
  const wrongId = fixture(() => ({ status: 200, body: charge({ txid: 'b'.repeat(32) }) }));
  await assert.rejects(wrongId.provider.getPayment(id), code('EFI_REFERENCE_MISMATCH'));
  const badCalendar = fixture(() => ({ status: 200, body: charge({ calendario: { criacao: 'unknown', expiracao: 3600 } }) }));
  await assert.rejects(badCalendar.provider.getPayment(id), code('EFI_INVALID_RESPONSE'));
});

test('código PIX canônico permite consulta mesmo quando o endpoint de imagem falha', async () => {
  const f = fixture(request => request.url.pathname.includes('/loc/') ? { status: 503, body: {} } : { status: 200, body: charge() });
  const payment = await f.provider.getPayment(id);
  assert.ok(payment.pixCopyPaste); assert.equal(payment.qrCode, undefined);
});

test('devolução usa referência estável e consulta canônica, incluindo reservas em processamento', async () => {
  let exists = false;
  const f = fixture(request => {
    if (request.url.pathname.endsWith(`/pix/${receipt}`)) return { status: 200, body: { endToEndId: receipt, txid: id, valor: '10.00' } };
    if (request.method === 'GET') return exists ? { status: 200, body: { id: 'refund1', status: 'EM_PROCESSAMENTO', valor: '10.00' } } : { status: 404, body: {} };
    exists = true;
    assert.equal(request.method, 'PUT'); assert.equal(request.url.pathname, `/v2/pix/${receipt}/devolucao/refund1`);
    assert.deepEqual(JSON.parse(request.body!), { valor: '10.00' });
    return { status: 201, body: { id: 'refund1', status: 'EM_PROCESSAMENTO', valor: '10.00' } };
  });
  assert.equal((await f.provider.refundPix(receipt, 'refund1', 1000)).status, 'pending');
  await f.provider.refundPix(receipt, 'refund1', 1000);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  const pending = fixture(request => request.url.pathname.endsWith(`/pix/${receipt}`)
    ? { status: 200, body: { endToEndId: receipt, txid: id, valor: '10.00', devolucoes: [{ id: 'prior', status: 'EM_PROCESSAMENTO', valor: '7.00' }] } }
    : { status: 404, body: {} });
  await assert.rejects(pending.provider.refundPix(receipt, 'refund2', 400), code('EFI_REFUND_LIMIT'));
  assert.equal(pending.calls.filter(c => c.method === 'PUT').length, 0);
});

test('configuração ausente ou certificado inválido desabilita o adapter antes da rede', () => {
  assert.throws(() => new EfiPixProvider({ ...config, certFile: '' }), code('EFI_DISABLED'));
  assert.throws(() => new EfiPixProvider(config), code('EFI_CERTIFICATE'));
  const dir = mkdtempSync(join(tmpdir(), 'efi-invalid-cert-'));
  try {
    const certFile = join(dir, 'invalid.p12'); writeFileSync(certFile, 'not a certificate');
    assert.throws(() => buildEfiHttpsAgent({ certFile }), code('EFI_CERTIFICATE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const f = fixture();
  assert.throws(() => f.provider.txidFor('invalid-reference'), code('EFI_INVALID_TXID'));
});

test('agente mTLS preserva validação TLS e rejeita servidor com CA não confiável', async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'efi-local-tls-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cert = join(dir, 'client.pem'); const key = join(dir, 'client.key'); const pfx = join(dir, 'client.p12');
  const create = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' });
  assert.equal(create.status, 0, 'openssl precisa gerar o certificado efêmero de teste.');
  const pack = spawnSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', pfx, '-passout', 'pass:unit-test-passphrase'], { stdio: 'pipe' });
  assert.equal(pack.status, 0, 'openssl precisa gerar o P12 efêmero de teste.');
  const agent = buildEfiHttpsAgent({ certFile: pfx, passphrase: 'unit-test-passphrase' }); t.after(() => agent.destroy());
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.minVersion, 'TLSv1.2');
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (_req, res) => res.end('{}'));
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const req = httpsRequest(`https://localhost:${address.port}`, { agent }, response => { response.resume(); response.on('end', resolve); });
    req.on('error', reject); req.end();
  }), error => error instanceof Error && /self.signed|unable to verify/i.test(error.message));
});
