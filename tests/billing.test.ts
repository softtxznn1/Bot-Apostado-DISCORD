import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { PaymentsService } from '../src/payments.js';
import { BillingService } from '../src/billing.js';
import { DomainError, type Actor } from '../src/domain.js';
import type { PixGateway, PixPayment, CreatePixInput } from '../src/payment-providers/types.js';

const admin: Actor = { userId: 'admin', moderator: true, mediator: false };
const med: Actor = { userId: 'mediator', moderator: false, mediator: true };
const p1: Actor = { userId: 'p1', moderator: false, mediator: false };
const p2: Actor = { userId: 'p2', moderator: false, mediator: false };
const outsider: Actor = { userId: 'outsider', moderator: false, mediator: false };
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;

class Gateway implements PixGateway {
  readonly calls: CreatePixInput[] = [];
  readonly lookups: string[] = [];
  payment: PixPayment | undefined;
  createHandler: ((input: CreatePixInput) => Promise<PixPayment>) | undefined;
  lookupHandler: ((id: string) => Promise<PixPayment>) | undefined;
  constructor(readonly name: PixGateway['name'] = 'mercadopago', readonly identity = `${name}-test-account`) {}
  async createPix(input: CreatePixInput): Promise<PixPayment> {
    this.calls.push(input);
    if (this.createHandler) return this.createHandler(input);
    this.payment = { id: `${this.name}-${this.calls.length}`, externalReference: input.reference,
      amountCents: input.amountCents, status: 'pending', pixCopyPaste: 'TEST-PIX-COPY-PASTE', qrCode: 'TEST-QR' };
    return this.payment;
  }
  async getPayment(id: string): Promise<PixPayment> {
    this.lookups.push(id);
    if (this.lookupHandler) return this.lookupHandler(id);
    assert.ok(this.payment); return this.payment;
  }
}

function setup(t: TestContext, options: { plan?: boolean; filename?: string; close?: boolean } = {}) {
  const store = new Store(options.filename ?? ':memory:');
  if (options.close !== false) t.after(() => store.close());
  const matches = new BotService(store);
  matches.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'mediators' }, admin);
  const queue = matches.createQueue('guild', admin, 1, 'mobile', 'Teste de conciliação de pagamentos.', 100);
  matches.joinQueue('guild', queue.id, p1.userId);
  const match = matches.joinQueue('guild', queue.id, p2.userId).match!;
  matches.confirm('guild', match.id, p1.userId); matches.confirm('guild', match.id, p2.userId);
  matches.claim('guild', match.id, med);
  const payments = new PaymentsService(store, matches);
  if (options.plan !== false) payments.configurePlan('guild', match.id, med, 0);
  const gateway = new Gateway();
  const billing = new BillingService(store, matches, payments, gateway);
  return { store, matches, match, payments, gateway, billing };
}

test('cobrança exige plano financeiro e autorização para o jogador escolhido', async t => {
  const noPlan = setup(t, { plan: false });
  await assert.rejects(noPlan.billing.requestCharge('guild', noPlan.match.id, p1, 'payer@example.test'), code('FINANCE_NOT_CONFIGURED'));
  assert.equal(noPlan.gateway.calls.length, 0);
  const f = setup(t);
  await assert.rejects(f.billing.requestCharge('guild', f.match.id, outsider, 'payer@example.test'), code('FORBIDDEN'));
  await assert.rejects(f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test', p2.userId), code('FORBIDDEN'));
  const intent = await f.billing.requestCharge('guild', f.match.id, med, 'payer@example.test', p1.userId);
  assert.equal(intent.userId, p1.userId);
  assert.equal(f.billing.get('guild', intent.id, p1).id, intent.id);
  assert.throws(() => f.billing.get('guild', intent.id, p2), code('FORBIDDEN'));
  assert.throws(() => f.billing.get('other-guild', intent.id, admin), code('PIX_NOT_FOUND'));
  assert.throws(() => f.billing.get('', intent.id, admin), code('PIX_NOT_FOUND'));
});

test('referência de 32 caracteres e intenção creating existem antes do POST', async t => {
  const f = setup(t);
  f.gateway.createHandler = async input => {
    const row = f.store.db.prepare('SELECT status,reference,payload FROM billing_intents WHERE reference=?').get(input.reference) as { status: string; reference: string; payload: string };
    assert.equal(row.status, 'creating');
    assert.match(input.reference, /^[a-zA-Z0-9]{32}$/);
    assert.equal(input.idempotencyKey, row.reference);
    assert.equal(input.amountCents, 100);
    assert.ok(!row.payload.includes('payer@example.test'));
    return { id: 'remote1', status: 'pending', externalReference: input.reference, amountCents: 100 };
  };
  const prepared = f.billing.prepare('guild', f.match.id, p1);
  assert.equal(prepared.status, 'prepared');
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  assert.equal(intent.reference, prepared.reference);
  assert.equal(intent.status, 'pending');
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all()).includes('payer@example.test'));
});

test('chamadas concorrentes e pedidos repetidos fazem somente um POST', async t => {
  const f = setup(t);
  let finish!: (value: PixPayment) => void;
  const pending = new Promise<PixPayment>(resolve => { finish = resolve; });
  f.gateway.createHandler = async () => pending;
  const first = f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  const existing = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  assert.equal(existing.status, 'creating');
  finish({ id: 'remote1', status: 'pending', amountCents: 100, externalReference: existing.reference });
  await first;
  const repeated = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  assert.equal(repeated.status, 'pending'); assert.equal(repeated.id, existing.id);
  assert.equal(f.gateway.calls.length, 1);
});

test('timeout sem ID fica incerto, não repete POST e não inventa consulta por ID', async t => {
  const f = setup(t);
  f.gateway.createHandler = async () => { throw new Error('Unexpected server body with SECRET'); };
  await assert.rejects(f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test'), error => code('PIX_CREATION_UNCERTAIN')(error) && !(error as Error).message.includes('SECRET'));
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  assert.equal(intent.status, 'uncertain'); assert.equal(intent.remoteId, null);
  assert.equal(f.gateway.calls.length, 1); assert.equal(f.billing.pending().length, 0);
  await assert.rejects(f.billing.reconcile('guild', intent.id, p1), code('PIX_REMOTE_ID_UNKNOWN'));
  assert.equal(f.gateway.lookups.length, 0);
});

test('consulta canônica aprovada credita uma única vez com origem provider', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.gateway.payment!.status = 'approved'; f.gateway.payment!.refundedCents = 0;
  const approved = await f.billing.reconcile('guild', intent.id, p1);
  await f.billing.reconcilePending(intent.id); await f.billing.reconcilePending(intent.id);
  assert.equal(approved.status, 'approved'); assert.ok(approved.creditedAt);
  assert.equal(f.gateway.lookups.length, 3);
  const history = f.payments.history('guild', f.match.id, med);
  assert.equal(history.length, 1); assert.equal(history[0]?.source, 'provider');
  assert.equal(history[0]?.provider, 'mercadopago');
  assert.equal(f.payments.summary('guild', f.match.id, med).receivedCents, 100);
  assert.equal(f.store.db.prepare('SELECT SUM(signed_cents) AS total FROM finance_entries').get()?.total, 0);
});

for (const field of ['amount', 'reference', 'remoteId'] as const) test(`consulta com ${field} incorreto exige revisão e não credita`, async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  const payment = { ...f.gateway.payment!, status: 'approved' as const };
  if (field === 'amount') payment.amountCents = 99;
  if (field === 'reference') payment.externalReference = 'different-reference';
  if (field === 'remoteId') payment.id = 'other-payment';
  f.gateway.payment = payment;
  await assert.rejects(f.billing.reconcile('guild', intent.id, p1), code('PIX_PAYMENT_MISMATCH'));
  const current = f.billing.get('guild', intent.id, p1);
  assert.equal(current.status, 'review'); assert.equal(current.remoteId, intent.remoteId);
  assert.equal(current.pixCopyPaste, undefined);
  assert.equal(f.payments.summary('guild', f.match.id, med).receivedCents, 0);
  assert.throws(() => f.billing.assertNoFinancialReview('guild', f.match.id), code('PIX_FINANCIAL_REVIEW'));
});

test('mudança de conta/provedor não consulta nem recria cobrança pendente', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  for (const gateway of [new Gateway('mercadopago', 'another-account'), new Gateway('efi')]) {
    const billing = new BillingService(f.store, f.matches, f.payments, gateway);
    await assert.rejects(billing.reconcile('guild', intent.id, p1), code('PIX_PROVIDER_CHANGED'));
    await assert.rejects(billing.requestCharge('guild', f.match.id, p1, 'payer@example.test'), code('PIX_PROVIDER_CHANGED'));
    assert.equal(billing.pending().length, 0); assert.equal(billing.findByRemoteId(intent.remoteId!), undefined);
    assert.equal(gateway.lookups.length, 0); assert.equal(gateway.calls.length, 0);
  }
});

test('Mercado Pago e Efí conciliam somente suas próprias cobranças', async t => {
  const f = setup(t); const efiGateway = new Gateway('efi');
  const efi = new BillingService(f.store, f.matches, f.payments, efiGateway);
  const mpIntent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  const efiIntent = await efi.requestCharge('guild', f.match.id, p2, 'other@example.test');
  assert.deepEqual(f.billing.pending().map(i => i.id), [mpIntent.id]);
  assert.deepEqual(efi.pending().map(i => i.id), [efiIntent.id]);
  assert.equal(f.billing.findByRemoteId(efiIntent.remoteId!), undefined);
  efiGateway.payment!.status = 'approved'; await efi.reconcilePending(efiIntent.id);
  assert.equal(f.payments.summary('guild', f.match.id, med).players.find(p => p.userId === p2.userId)?.receivedCents, 100);
});

test('pagamento parcial ou totalmente estornado não gera recebimento', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.gateway.payment!.status = 'approved'; f.gateway.payment!.refundedCents = 50;
  const partial = await f.billing.reconcile('guild', intent.id, p1);
  assert.equal(partial.status, 'review'); assert.equal(partial.creditedAt, null);
  assert.equal(f.payments.summary('guild', f.match.id, med).receivedCents, 0);
  f.gateway.payment!.status = 'refunded'; f.gateway.payment!.refundedCents = 100;
  const full = await f.billing.reconcile('guild', intent.id, p1);
  assert.equal(full.status, 'refunded'); assert.equal(full.creditedAt, null);
});

test('aprovação que chega após cancelar registra dinheiro recebido e estorno devido', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.matches.cancel('guild', f.match.id, med, 'Partida cancelada antes do pagamento chegar.');
  f.gateway.payment!.status = 'approved';
  const approved = await f.billing.reconcile('guild', intent.id, p1);
  const summary = f.payments.summary('guild', f.match.id, med);
  assert.equal(approved.status, 'approved'); assert.equal(summary.receivedCents, 100);
  assert.equal(summary.status, 'refunding'); assert.equal(summary.recordedCustodyCents, 100);
});

test('estorno remoto após crédito preserva histórico e bloqueia liquidação', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.gateway.payment!.status = 'approved'; await f.billing.reconcilePending(intent.id);
  f.gateway.payment!.status = 'refunded'; f.gateway.payment!.refundedCents = 100;
  const refunded = await f.billing.reconcilePending(intent.id);
  assert.equal(refunded.reviewReason, 'REMOTE_REFUND_AFTER_CREDIT');
  assert.ok(refunded.creditedAt);
  assert.equal(f.payments.history('guild', f.match.id, med).length, 1);
  assert.throws(() => f.billing.assertNoFinancialReview('guild', f.match.id), code('PIX_FINANCIAL_REVIEW'));
  f.gateway.payment!.status = 'approved'; f.gateway.payment!.refundedCents = 0;
  const delayedApproval = await f.billing.reconcilePending(intent.id);
  assert.equal(delayedApproval.status, 'review');
  assert.equal(f.payments.history('guild', f.match.id, med).length, 1);
});

test('falha após lançar o recebimento faz rollback do ledger e da aprovação juntos', async t => {
  const f = setup(t);
  class FailingPayments extends PaymentsService {
    override confirmProviderReceipt(...args: Parameters<PaymentsService['confirmProviderReceipt']>): ReturnType<PaymentsService['confirmProviderReceipt']> {
      super.confirmProviderReceipt(...args);
      throw new Error('Crash before the billing approval persisted');
    }
  }
  const payments = new FailingPayments(f.store, f.matches);
  const billing = new BillingService(f.store, f.matches, payments, f.gateway);
  f.gateway.createHandler = async input => ({ id: 'remote1', status: 'approved', amountCents: input.amountCents, externalReference: input.reference });
  await assert.rejects(billing.requestCharge('guild', f.match.id, p1, 'payer@example.test'), code('PIX_REVIEW_REQUIRED'));
  assert.equal(f.payments.history('guild', f.match.id, med).length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM finance_entries').get()?.count, 0);
  const row = f.store.db.prepare('SELECT payload FROM billing_intents').get() as { payload: string };
  const intent = JSON.parse(row.payload);
  assert.equal(intent.status, 'review'); assert.equal(intent.creditedAt, null); assert.equal(intent.remoteId, 'remote1');
});

test('conferência manual durante PIX pendente causa revisão em vez de duplicar recebimento', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.payments.confirmReceipt('guild', f.match.id, med, p1.userId, 100, 'manual-reference', 'manual-key');
  f.gateway.payment!.status = 'approved';
  await assert.rejects(f.billing.reconcilePending(intent.id), code('PIX_REVIEW_REQUIRED'));
  assert.equal(f.payments.history('guild', f.match.id, med).length, 1);
  assert.equal(f.payments.summary('guild', f.match.id, med).receivedCents, 100);
  assert.equal(f.billing.get('guild', intent.id, p1).status, 'review');
});

test('intenção e QR persistem, mas e-mail não persiste e lookup é retomado após reabrir SQLite', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-billing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'bot.sqlite');
  const f = setup(t, { filename, close: false });
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.store.close();
  const store = new Store(filename); t.after(() => store.close());
  const matches = new BotService(store); const payments = new PaymentsService(store, matches);
  const billing = new BillingService(store, matches, payments, f.gateway);
  assert.equal(billing.get('guild', intent.id, p1).pixCopyPaste, 'TEST-PIX-COPY-PASTE');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM billing_intents').all()).includes('payer@example.test'));
  f.gateway.payment!.status = 'approved';
  await billing.reconcilePending(intent.id);
  assert.equal(payments.history('guild', f.match.id, med).length, 1);
});

test('erro de consulta e resposta pendente nunca são tratados como aprovação', async t => {
  const f = setup(t);
  const intent = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  f.gateway.lookupHandler = async () => { throw new Error('SECRET provider response'); };
  await assert.rejects(f.billing.reconcilePending(intent.id), error => code('PIX_LOOKUP_FAILED')(error) && !(error as Error).message.includes('SECRET'));
  assert.equal(f.billing.get('guild', intent.id, p1).status, 'pending');
  assert.equal(f.payments.history('guild', f.match.id, med).length, 0);
});

test('criação incerta sem ID é recuperada somente por busca de referência, sem outro POST', async t => {
  const f = setup(t);
  let payment: PixPayment | undefined;
  const gateway: PixGateway = f.gateway;
  f.gateway.createHandler = async input => {
    payment = { id: 'lost-response', status: 'approved', amountCents: input.amountCents, externalReference: input.reference };
    throw new Error('Response lost');
  };
  let searches = 0;
  gateway.findPaymentByReference = async reference => { searches++; assert.equal(reference, payment?.externalReference); return payment; };
  await assert.rejects(f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test'), code('PIX_CREATION_UNCERTAIN'));
  const intent = f.billing.pending()[0]!;
  assert.equal(intent.remoteId, null);
  const recovered = await f.billing.reconcile('guild', intent.id, p1);
  assert.equal(recovered.status, 'approved'); assert.equal(searches, 1); assert.equal(f.gateway.calls.length, 1);
  assert.equal(f.payments.summary('guild', f.match.id, p1).receivedCents, 100);
});

test('erro local comprovado não prende cobrança que nunca foi enviada', async t => {
  const f = setup(t); let rejectLocally = true;
  f.gateway.createHandler = async input => {
    if (rejectLocally) throw new DomainError('MP_INVALID_PAYER', 'Invalid local payer');
    return { id: 'remote-valid', status: 'pending', amountCents: input.amountCents, externalReference: input.reference };
  };
  await assert.rejects(f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test'), code('PIX_CREATE_REJECTED'));
  rejectLocally = false;
  const result = await f.billing.requestCharge('guild', f.match.id, p1, 'payer@example.test');
  assert.equal(result.status, 'pending');
  assert.equal(f.gateway.calls[0]?.reference, f.gateway.calls[1]?.reference);
});

test('cobrança Efí não exige nem persiste um e-mail que seu contrato não utiliza', async t => {
  const f = setup(t); const gateway = new Gateway('efi');
  const billing = new BillingService(f.store, f.matches, f.payments, gateway);
  assert.equal((await billing.requestCharge('guild', f.match.id, p1, '')).status, 'pending');
});
