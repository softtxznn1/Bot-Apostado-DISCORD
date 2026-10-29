import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './database.js';
import { BotService } from './service.js';
import { PaymentsService } from './payments.js';
import { BillingService } from './billing.js';
import { SimulatedRoomProvider } from './providers.js';
import { reportError } from './config.js';
import type { PixGateway, PixPayment } from './payment-providers/types.js';

async function demo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ff-full-demo-')); const file = join(dir, 'bot.sqlite');
  let store = new Store(file);
  try {
    const service = new BotService(store); const payments = new PaymentsService(store, service);
    const admin = { userId: 'admin-demo', moderator: true, mediator: false };
    service.configure({ guildId: 'demo', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med' }, admin);
    const queue = service.createQueue('demo', admin, 1, 'mobile', 'SIMULAÇÃO sem dinheiro ou sala reais.', 1000);
    service.joinQueue('demo', queue.id, 'player-1'); const match = service.joinQueue('demo', queue.id, 'player-2').match!;
    for (const p of match.players) service.confirm('demo', match.id, p.userId);
    service.claim('demo', match.id, admin); payments.configurePlan('demo', match.id, admin, 500);
    const bank = new Map<string, PixPayment>();
    const gateway: PixGateway = {
      name: 'mercadopago', identity: 'SIMULATED-BANK-NO-REAL-CREDENTIALS',
      async createPix(input) {
        const payment: PixPayment = { id: input.reference, status: 'pending', amountCents: input.amountCents, externalReference: input.reference };
        bank.set(payment.id, payment); return payment;
      },
      async getPayment(id) { const payment = bank.get(id); assert.ok(payment); return payment; },
    };
    const billing = new BillingService(store, service, payments, gateway);
    for (const player of match.players) {
      const actor = { userId: player.userId, moderator: false, mediator: false };
      const intent = await billing.requestCharge('demo', match.id, actor, 'demo@example.test');
      bank.get(intent.remoteId!)!.status = 'approved';
      await billing.reconcile('demo', intent.id, actor);
      await billing.reconcile('demo', intent.id, actor);
    }
    payments.assertFundedForPlay('demo', match.id);
    assert.equal(payments.summary('demo', match.id, admin).receivedCents, 2000);
    await service.createRoom('demo', match.id, admin, new SimulatedRoomProvider());
    service.startMatch('demo', match.id, admin); service.proposeResult('demo', match.id, admin, 1, '7x3');
    for (const p of match.players) service.acceptResult('demo', match.id, p.userId);
    payments.payPrize('demo', match.id, admin, 'player-1', 1900, 'demo:prize', 'demo:prize');
    payments.payFee('demo', match.id, admin, 100, 'demo:fee', 'demo:fee');
    assert.equal(payments.summary('demo', match.id, admin).status, 'settled');
    store.close(); store = new Store(file);
    const recovered = new BotService(store); const restored = new PaymentsService(store, recovered);
    assert.equal(recovered.ranking('demo')[0]?.wins, 1);
    assert.equal(restored.summary('demo', match.id, admin).recordedCustodyCents, 0);
    console.log('SIMULAÇÃO COMPLETA: fila → confirmações → plano financeiro → cobranças → consulta de banco SIMULADO → sala SIMULADA → resultado → prêmio/taxa registrados.');
    console.log('Conciliação duplicada não duplica recebimentos. Ledger, ranking e encerramento preservados após reabrir SQLite.');
    console.log('Nenhum acesso ao Discord, Mercado Pago, Efí ou Free Fire. Nenhum dinheiro movimentado.');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
void demo().catch(error => { reportError(error, 'demo_full'); process.exitCode = 1; });
