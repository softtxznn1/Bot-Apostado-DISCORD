import { createHash } from 'node:crypto';
import { BillingService } from './billing.js';
import { PaymentsService } from './payments.js';
import { BotService } from './service.js';
import { DomainError, requireCondition } from './domain.js';
import { MercadoPagoPixProvider } from './payment-providers/mercadopago.js';
import { EfiPixProvider } from './payment-providers/efi.js';
import type { PixGateway, PixPayment } from './payment-providers/types.js';
import { reportError } from './config.js';

export class PaymentHub {
  readonly billings = new Map<PixGateway['name'], BillingService>();
  readonly mercadoPago: MercadoPagoPixProvider | undefined;
  readonly defaultProvider: string;
  private polling = false;

  constructor(private readonly service: BotService, payments: PaymentsService, env: NodeJS.ProcessEnv = process.env) {
    this.defaultProvider = env.PAYMENT_PROVIDER || 'manual';
    requireCondition(['manual', 'mercadopago', 'efi'].includes(this.defaultProvider), 'PIX_CONFIG', 'PAYMENT_PROVIDER deve ser manual, mercadopago ou efi.');
    if (env.MP_ACCESS_TOKEN) {
      this.mercadoPago = new MercadoPagoPixProvider({ accessToken: env.MP_ACCESS_TOKEN, webhookSecret: env.MP_WEBHOOK_SECRET || undefined });
      const provider = this.mercadoPago;
      const gateway: PixGateway = {
        name: 'mercadopago',
        identity: `mercadopago:${createHash('sha256').update(env.MP_ACCESS_TOKEN).digest('hex')}`,
        createPix: input => provider.createPix(input), getPayment: id => provider.getPayment(id),
        findPaymentByReference: reference => provider.findPaymentByReference(reference),
      };
      this.billings.set('mercadopago', new BillingService(service.store, service, payments, gateway));
    }
    const efiNames = ['EFI_CLIENT_ID', 'EFI_CLIENT_SECRET', 'EFI_PIX_KEY', 'EFI_CERT_FILE'] as const;
    const efiConfigured = efiNames.every(name => !!env[name]);
    if (this.defaultProvider === 'efi' || efiConfigured) {
      requireCondition(efiConfigured, 'PIX_CONFIG', 'Efí exige EFI_CLIENT_ID, EFI_CLIENT_SECRET, EFI_PIX_KEY e EFI_CERT_FILE nas configurações seguras.');
      requireCondition(env.EFI_SANDBOX === undefined || ['true', 'false'].includes(env.EFI_SANDBOX), 'PIX_CONFIG', 'EFI_SANDBOX deve ser true ou false.');
      const gateway = new EfiPixProvider({
        clientId: env.EFI_CLIENT_ID!, clientSecret: env.EFI_CLIENT_SECRET!, pixKey: env.EFI_PIX_KEY!,
        certFile: env.EFI_CERT_FILE!, keyFile: env.EFI_KEY_FILE || undefined,
        passphrase: env.EFI_CERT_PASSPHRASE || undefined, sandbox: env.EFI_SANDBOX !== 'false',
      });
      const adapter: PixGateway = { name: 'efi', identity: gateway.identity,
        createPix: input => gateway.createPix(input), getPayment: id => gateway.getPayment(id),
        findPaymentByReference: async reference => {
          try { return await gateway.getPayment(reference); }
          catch (error) { if (error instanceof DomainError && 'status' in error && error.status === 404) return undefined; throw error; }
        } };
      this.billings.set('efi', new BillingService(service.store, service, payments, adapter));
    }
    if (this.defaultProvider !== 'manual') this.billing(this.defaultProvider);
  }

  billing(provider = this.defaultProvider): BillingService {
    requireCondition(provider === 'mercadopago' || provider === 'efi', 'PIX_NOT_CONFIGURED', 'Escolha Mercado Pago ou Efí e configure as credenciais seguras. O modo atual é manual.');
    const billing = this.billings.get(provider);
    requireCondition(billing, 'PIX_NOT_CONFIGURED', `O provedor ${provider} ainda não foi configurado neste ambiente.`);
    return billing;
  }

  assertNoFinancialReview(guildId: string, matchId: string): void {
    const table = this.service.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_intents'").get();
    if (!table) return;
    const review = this.service.store.db.prepare(`SELECT 1 FROM billing_intents WHERE guild_id=? AND match_id=?
      AND (status='review' OR (status='refunded' AND json_extract(payload,'$.creditedAt') IS NOT NULL)) LIMIT 1`).get(guildId, matchId);
    requireCondition(!review, 'FINANCIAL_REVIEW', 'Existe pagamento que exige conciliação financeira. Revise o provedor e o histórico antes de prosseguir.');
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const billing of this.billings.values()) for (const intent of billing.pending(20)) {
        try { await billing.reconcilePending(intent.id); }
        catch (error) { reportError(error, 'pix_reconcile'); }
      }
    } finally { this.polling = false; }
  }

  async acceptMercadoPagoWebhook(payment: PixPayment): Promise<void> {
    const billing = this.billings.get('mercadopago');
    if (!billing) throw new DomainError('PIX_NOT_CONFIGURED', 'Mercado Pago não configurado.');
    const intent = billing.findByRemoteId(payment.id);
    // Pagamentos de outras aplicações/partidas não criam lançamentos neste bot.
    if (intent) await billing.reconcilePending(intent.id);
  }
}
