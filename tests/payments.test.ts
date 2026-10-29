import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { PaymentsService } from '../src/payments.js';
import { DomainError, type Actor, type Match } from '../src/domain.js';
import { paymentCommands } from '../src/bot/payment-commands.js';
import { financeSummaryText } from '../src/bot/payment-handler.js';

const admin: Actor = { userId: 'admin', moderator: true, mediator: false };
const med: Actor = { userId: 'mediator', moderator: false, mediator: true };
const outsider: Actor = { userId: 'outsider', moderator: false, mediator: false };
const isCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function setup(t: TestContext, teamSize = 1, stakeCents = 100) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const matches = new BotService(store);
  matches.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'mediator-role' }, admin);
  const q = matches.createQueue('guild', admin, teamSize, 'mobile', 'Teste financeiro manual, sem conexão bancária.', stakeCents);
  let match: Match | undefined;
  for (let n = 0; n < teamSize * 2; n++) match = matches.joinQueue('guild', q.id, `player-${n}`).match ?? match;
  assert.ok(match);
  for (const p of match.players) matches.confirm('guild', match.id, p.userId);
  match = matches.claim('guild', match.id, med);
  const finance = new PaymentsService(store, matches);
  return { store, matches, finance, match };
}
function payAll(f: ReturnType<typeof setup>) {
  for (const p of f.match.players) f.finance.confirmReceipt('guild', f.match.id, med, p.userId, f.match.stakeCents, `receipt-${p.userId}`, `key-${p.userId}`);
}
function finish(f: ReturnType<typeof setup>, winner = 1) {
  f.matches.informRoom('guild', f.match.id, med, '12345', 'secret');
  f.matches.startMatch('guild', f.match.id, med);
  f.matches.proposeResult('guild', f.match.id, med, winner, winner === 1 ? '7x3' : '3x7');
  for (const team of [1, 2]) f.matches.acceptResult('guild', f.match.id, f.match.players.find(p => p.team === team)!.userId);
}

test('plano exige mediador atribuído e fixa taxa antes da criação da sala', t => {
  const f = setup(t);
  assert.throws(() => f.finance.configurePlan('guild', f.match.id, outsider, 1000), isCode('FORBIDDEN'));
  assert.throws(() => f.finance.configurePlan('guild', f.match.id, { ...med, userId: 'another-med' }, 1000), isCode('FORBIDDEN'));
  assert.throws(() => f.finance.configurePlan('guild', f.match.id, med, 10001), isCode('INVALID_FEE'));
  const plan = f.finance.configurePlan('guild', f.match.id, med, 1250);
  assert.equal(plan.feeCents, 25); assert.equal(plan.prizeCents, 175);
  assert.deepEqual(f.finance.configurePlan('guild', f.match.id, admin, 1250), plan);
  assert.throws(() => f.finance.configurePlan('guild', f.match.id, med, 1500), isCode('PLAN_IMMUTABLE'));
  assert.throws(() => f.store.db.prepare('UPDATE finance_plans SET payload=?').run('{}'), /immutable/);
});

test('plano inexistente não bloqueia partida informativa, mas plano incompleto bloqueia sala e jogo', t => {
  const f = setup(t);
  f.finance.assertReadyForRoom('guild', f.match.id);
  f.finance.configurePlan('guild', f.match.id, med, 0);
  assert.throws(() => f.finance.assertReadyForRoom('guild', f.match.id), isCode('NOT_FUNDED'));
  f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'receipt-0', 'key-0');
  assert.throws(() => f.finance.assertFundedForPlay('guild', f.match.id), isCode('NOT_FUNDED'));
  f.finance.confirmReceipt('guild', f.match.id, med, 'player-1', 100, 'receipt-1', 'key-1');
  f.finance.assertFundedForPlay('guild', f.match.id);
});

test('conferência exige valor exato e referências não duplicadas', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0);
  assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 99, 'bank-0', 'key-0'), isCode('AMOUNT_MISMATCH'));
  assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'outsider', 100, 'bank-0', 'key-0'), isCode('NOT_PARTICIPANT'));
  const first = f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'bank-0', 'key-0');
  assert.deepEqual(f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'bank-0', 'key-0'), first);
  assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 101, 'bank-0', 'key-0'), isCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'player-1', 100, 'bank-0', 'key-1'), isCode('REFERENCE_REUSED'));
  assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'bank-other', 'key-other'), isCode('ALREADY_RECORDED'));
  assert.equal(f.finance.summary('guild', f.match.id, med).receivedCents, 100);
});

test('ledger é balanceado e imutável e somente registros manuais são exibidos', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0); payAll(f);
  const rows = f.store.db.prepare('SELECT operation_id,SUM(signed_cents) AS total,COUNT(*) AS entries FROM finance_entries GROUP BY operation_id').all() as { total: number; entries: number }[];
  assert.ok(rows.every(r => r.total === 0 && r.entries === 2));
  assert.throws(() => f.store.db.prepare('DELETE FROM finance_entries').run(), /append-only/);
  assert.throws(() => f.store.db.prepare('UPDATE finance_operations SET amount_cents=1').run(), /append-only/);
  const summary = f.finance.summary('guild', f.match.id, med);
  assert.equal(summary.source, 'manual_records');
  assert.ok(financeSummaryText(summary).includes('não consulta saldo bancário'));
  assert.ok(!financeSummaryText(summary).includes('receipt-player'));
});

test('taxa e divisão do prêmio preservam todos os centavos entre vencedores', t => {
  const f = setup(t, 2, 101); const plan = f.finance.configurePlan('guild', f.match.id, med, 333);
  assert.equal(plan.expectedTotalCents, 404); assert.equal(plan.feeCents, 13); assert.equal(plan.prizeCents, 391);
  payAll(f); finish(f);
  const summary = f.finance.summary('guild', f.match.id, med);
  assert.deepEqual(summary.players.map(p => p.prizeDueCents), [196, 195, 0, 0]);
  for (const p of summary.players.filter(p => p.prizeDueCents)) f.finance.payPrize('guild', f.match.id, med, p.userId, p.prizeDueCents, `prize-${p.userId}`, `prize-key-${p.userId}`);
  f.finance.payFee('guild', f.match.id, med, 13, 'fee-bank', 'fee-key');
  const after = f.finance.summary('guild', f.match.id, med);
  assert.equal(after.status, 'settled'); assert.equal(after.recordedCustodyCents, 0);
  assert.equal(after.prizesPaidCents + after.feesPaidCents, after.receivedCents);
});

test('prêmio não pode sair antes do resultado nem ir a perdedor ou ter valor incorreto', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 1000); payAll(f);
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-0', 180, 'prize-0', 'prize-key'), isCode('INVALID_STATE'));
  finish(f);
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-1', 180, 'prize-1', 'prize-key'), isCode('AMOUNT_MISMATCH'));
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-0', 179, 'prize-0', 'prize-key'), isCode('AMOUNT_MISMATCH'));
  const payout = f.finance.payPrize('guild', f.match.id, med, 'player-0', 180, 'prize-0', 'prize-key');
  assert.deepEqual(f.finance.payPrize('guild', f.match.id, med, 'player-0', 180, 'prize-0', 'prize-key'), payout);
  assert.equal(f.finance.summary('guild', f.match.id, med).prizesPaidCents, 180);
});

test('resultado final sem todas as conferências não permite premiação', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0);
  f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'receipt-0', 'key-0');
  finish(f);
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-0', 200, 'prize-0', 'key-prize'), isCode('NOT_FUNDED'));
});

test('disputa bloqueia prêmio e decisão da moderação define beneficiários', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0); payAll(f);
  f.matches.informRoom('guild', f.match.id, med, '12345', 'secret'); f.matches.startMatch('guild', f.match.id, med);
  f.matches.proposeResult('guild', f.match.id, med, 1, '7x3');
  f.matches.dispute('guild', f.match.id, 'player-1', 'Vídeo de revisão necessário.');
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-0', 200, 'prize-0', 'prize-key'), isCode('INVALID_STATE'));
  f.matches.resolve('guild', f.match.id, admin, 2, 'Vídeo conferido.');
  assert.equal(f.finance.summary('guild', f.match.id, med).players.find(p => p.userId === 'player-1')?.prizeDueCents, 200);
});

test('cancelamento exige estorno integral por recebimento e não permite prêmio', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0);
  f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', 100, 'receipt-0', 'receipt-key');
  assert.throws(() => f.finance.refund('guild', f.match.id, med, 'player-0', 100, 'refund-0', 'refund-key'), isCode('INVALID_STATE'));
  f.matches.cancel('guild', f.match.id, med, 'Jogador desistiu antes da sala.');
  assert.throws(() => f.finance.payPrize('guild', f.match.id, med, 'player-0', 100, 'prize-0', 'prize-key'), isCode('INVALID_STATE'));
  assert.throws(() => f.finance.refund('guild', f.match.id, med, 'player-1', 100, 'refund-1', 'refund-key-1'), isCode('NOT_PAID'));
  assert.throws(() => f.finance.refund('guild', f.match.id, med, 'player-0', 99, 'refund-0', 'refund-key'), isCode('AMOUNT_MISMATCH'));
  f.finance.refund('guild', f.match.id, med, 'player-0', 100, 'refund-0', 'refund-key');
  const after = f.finance.summary('guild', f.match.id, med);
  assert.equal(after.refundedCents, 100); assert.equal(after.recordedCustodyCents, 0); assert.equal(after.status, 'refunded');
});

test('nenhum relatório ou referência de transferência vaza para outro servidor ou visitante', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0); payAll(f);
  assert.throws(() => f.finance.summary('guild', f.match.id, outsider), isCode('FORBIDDEN'));
  assert.throws(() => f.finance.summary('other-guild', f.match.id, admin), isCode('NOT_FOUND'));
  assert.throws(() => f.finance.report('guild', med), isCode('FORBIDDEN'));
  const player = { ...outsider, userId: 'player-0' };
  assert.equal(f.finance.charge('guild', f.match.id, player).amountCents, 100);
  assert.throws(() => f.finance.charge('guild', f.match.id, player, 'player-1'), isCode('FORBIDDEN'));
  assert.throws(() => f.finance.history('guild', f.match.id, player), isCode('FORBIDDEN'));
  const safeSummary = f.finance.summary('guild', f.match.id, player);
  assert.ok(!JSON.stringify(safeSummary).includes('receipt-player'));
});

test('saldo, referência e idempotência sobrevivem à reabertura do banco', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-finance-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'finance.sqlite'); let store = new Store(filename); let matches = new BotService(store);
  matches.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med' }, admin);
  const q = matches.createQueue('guild', admin, 1, 'mobile', 'Registros persistentes.', 100);
  matches.joinQueue('guild', q.id, 'p1'); const m = matches.joinQueue('guild', q.id, 'p2').match!;
  matches.confirm('guild', m.id, 'p1'); matches.confirm('guild', m.id, 'p2'); matches.claim('guild', m.id, med);
  let finance = new PaymentsService(store, matches); finance.configurePlan('guild', m.id, med, 0);
  const original = finance.confirmReceipt('guild', m.id, med, 'p1', 100, 'bank-ref', 'operation-key');
  store.close(); store = new Store(filename); matches = new BotService(store); finance = new PaymentsService(store, matches);
  try {
    assert.equal(finance.summary('guild', m.id, med).recordedCustodyCents, 100);
    assert.deepEqual(finance.confirmReceipt('guild', m.id, med, 'p1', 100, 'bank-ref', 'operation-key'), original);
    assert.equal(finance.history('guild', m.id, med).length, 1);
  } finally { store.close(); }
});

test('recibos concorrentes com a mesma referência produzem uma única operação', async t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0);
  await Promise.allSettled(['player-0', 'player-1'].map((user, n) => Promise.resolve().then(() => f.finance.confirmReceipt('guild', f.match.id, med, user, 100, 'same-bank-ref', `operation-${n}`))));
  assert.equal(f.finance.history('guild', f.match.id, med).length, 1);
  assert.equal(f.finance.summary('guild', f.match.id, med).receivedCents, 100);
});

test('zero, valores fracionários e totais fora de inteiros seguros são rejeitados', t => {
  const f = setup(t); f.finance.configurePlan('guild', f.match.id, med, 0);
  for (const amount of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => f.finance.confirmReceipt('guild', f.match.id, med, 'player-0', amount, 'bank-ref', 'key-0'), isCode('INVALID_AMOUNT'));
  const huge = setup(t, 1, Number.MAX_SAFE_INTEGER);
  assert.throws(() => huge.finance.configurePlan('guild', huge.match.id, med, 0), isCode('INVALID_AMOUNT'));
});

test('comando financeiro explicita operação manual e possui opções válidas', () => {
  assert.equal(paymentCommands.length, 1);
  assert.equal(paymentCommands[0]?.name, 'financeiro');
  assert.ok(paymentCommands[0]?.description.includes('não gera PIX'));
  assert.ok(paymentCommands[0]?.options?.some(o => o.name === 'premiar'));
});
