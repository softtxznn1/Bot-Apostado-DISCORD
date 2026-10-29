import { randomUUID } from 'node:crypto';
import { Store } from './database.js';
import { DomainError, requireCondition, type Actor, type Match } from './domain.js';
import { BotService } from './service.js';
import { PaymentsService } from './payments.js';
import type { PixGateway, PixPayment, PixStatus } from './payment-providers/types.js';

export type BillingStatus = 'prepared' | 'creating' | 'pending' | 'approved' | 'uncertain'
  | 'cancelled' | 'refunded' | 'expired' | 'rejected' | 'review';
export type BillingIntent = {
  id: string; guildId: string; matchId: string; userId: string;
  provider: PixGateway['name']; providerIdentity: string; reference: string;
  amountCents: number; status: BillingStatus; remoteId: string | null;
  createdAt: number; updatedAt: number; creditedAt: number | null;
  pixCopyPaste?: string; qrCode?: string; expiresAt?: string;
  remoteStatus?: PixStatus; reviewReason?: string;
};
type Row = { payload: string };
const statuses: ReadonlySet<string> = new Set(['pending', 'approved', 'cancelled', 'refunded', 'expired', 'rejected', 'unknown']);

const schema = `
  CREATE TABLE billing_intents (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id),
    user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_identity TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    status TEXT NOT NULL, remote_id TEXT, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(guild_id,match_id,user_id)
  );
  CREATE UNIQUE INDEX billing_remote_payment
    ON billing_intents(provider,provider_identity,remote_id) WHERE remote_id IS NOT NULL;
  CREATE INDEX billing_pending ON billing_intents(provider,provider_identity,status);
`;

/**
 * Charges are prepared durably before any HTTP request. An uncertain creation is
 * never posted again; canonical GET is the only reconciliation operation.
 * Caller-owned transactions must not be held open over asynchronous provider I/O.
 */
export class BillingService {
  constructor(
    private readonly store: Store, private readonly matches: BotService,
    private readonly payments: PaymentsService, private readonly gateway: PixGateway,
    private readonly now = Date.now,
  ) {
    requireCondition(gateway.identity.length >= 1 && gateway.identity.length <= 256, 'PIX_CONFIG', 'Identificação da conta de pagamento inválida.');
    store.migrateFeature('billing', 1, schema);
  }

  private atomically<T>(work: () => T): T {
    return this.store.db.isTransaction ? work() : this.store.transaction(work);
  }
  private raw(id: string, guildId?: string): BillingIntent {
    const row = guildId !== undefined
      ? this.store.db.prepare('SELECT payload FROM billing_intents WHERE id=? AND guild_id=?').get(id, guildId)
      : this.store.db.prepare('SELECT payload FROM billing_intents WHERE id=?').get(id);
    requireCondition(row, 'PIX_NOT_FOUND', 'Cobrança não encontrada neste servidor.');
    return JSON.parse((row as Row).payload) as BillingIntent;
  }
  private operator(match: Match, actor: Actor): boolean {
    return actor.moderator || (actor.mediator && match.mediatorId === actor.userId);
  }
  private authorize(intent: BillingIntent, actor: Actor): void {
    const match = this.matches.viewMatch(intent.guildId, intent.matchId, actor);
    requireCondition(intent.userId === actor.userId || this.operator(match, actor), 'FORBIDDEN', 'Você não tem acesso à cobrança deste jogador.');
  }
  private sameAccount(intent: BillingIntent): void {
    requireCondition(intent.provider === this.gateway.name && intent.providerIdentity === this.gateway.identity,
      'PIX_PROVIDER_CHANGED', 'Esta cobrança pertence a outro provedor ou conta. Recupere a configuração original para consultá-la.');
  }
  private save(intent: BillingIntent): BillingIntent {
    intent.updatedAt = this.now();
    this.store.db.prepare(`UPDATE billing_intents SET status=?,remote_id=?,payload=?,updated_at=? WHERE id=? AND guild_id=?`)
      .run(intent.status, intent.remoteId, JSON.stringify(intent), intent.updatedAt, intent.id, intent.guildId);
    return intent;
  }
  private audit(intent: BillingIntent, action: string): void {
    this.store.db.prepare('INSERT INTO audit(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
      .run(intent.guildId, intent.matchId, `provider:${intent.provider}`, action, this.now(), JSON.stringify({
        intentId: intent.id, userId: intent.userId, provider: intent.provider,
        amountCents: intent.amountCents, status: intent.status, ...(intent.reviewReason ? { reason: intent.reviewReason } : {}),
      }));
  }

  prepare(guildId: string, matchId: string, actor: Actor, userId = actor.userId): BillingIntent {
    return this.atomically(() => {
      // charge checks participant/assigned operator access and the match state.
      const charge = this.payments.charge(guildId, matchId, actor, userId);
      const existing = this.store.db.prepare('SELECT payload FROM billing_intents WHERE guild_id=? AND match_id=? AND user_id=?')
        .get(guildId, matchId, userId) as Row | undefined;
      if (existing) {
        const intent = JSON.parse(existing.payload) as BillingIntent;
        this.sameAccount(intent); return intent;
      }
      const summary = this.payments.summary(guildId, matchId, actor);
      requireCondition(summary.players.find(p => p.userId === userId)?.receivedCents === 0, 'PIX_ALREADY_PAID', 'Já existe um recebimento registrado para este jogador. Não gere outra cobrança.');
      const id = randomUUID(); const now = this.now();
      const intent: BillingIntent = {
        id, guildId, matchId, userId, provider: this.gateway.name, providerIdentity: this.gateway.identity,
        reference: id.replaceAll('-', ''), amountCents: charge.amountCents, status: 'prepared', remoteId: null,
        createdAt: now, updatedAt: now, creditedAt: null,
      };
      this.store.db.prepare(`INSERT INTO billing_intents
        (id,guild_id,match_id,user_id,provider,provider_identity,reference,amount_cents,status,remote_id,payload,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, guildId, matchId, userId, intent.provider, intent.providerIdentity,
        intent.reference, intent.amountCents, intent.status, null, JSON.stringify(intent), now, now);
      this.audit(intent, 'pix_charge_prepared'); return intent;
    });
  }

  async requestCharge(guildId: string, matchId: string, actor: Actor, payerEmail: string, userId = actor.userId): Promise<BillingIntent> {
    requireCondition(!this.store.db.isTransaction, 'PIX_TRANSACTION', 'Não mantenha uma transação de banco aberta durante a chamada ao provedor.');
    requireCondition(this.gateway.name !== 'mercadopago' || (typeof payerEmail === 'string' && payerEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)), 'PIX_EMAIL', 'Informe um e-mail válido para o pagador Mercado Pago.');
    const prepared = this.prepare(guildId, matchId, actor, userId);
    const claimed = this.store.transaction(() => {
      const intent = this.raw(prepared.id, guildId); this.sameAccount(intent);
      if (intent.status !== 'prepared') return { intent, send: false };
      // Another process may have recorded a manual receipt since prepare().
      const summary = this.payments.summary(guildId, matchId, actor);
      requireCondition(summary.players.find(p => p.userId === userId)?.receivedCents === 0, 'PIX_ALREADY_PAID', 'Já existe um recebimento registrado. Não gere outra cobrança.');
      this.payments.charge(guildId, matchId, actor, userId);
      intent.status = 'creating'; this.save(intent); this.audit(intent, 'pix_charge_requested');
      return { intent, send: true };
    });
    if (!claimed.send) return claimed.intent;
    let payment: PixPayment;
    try {
      payment = await this.gateway.createPix({
        reference: claimed.intent.reference, idempotencyKey: claimed.intent.reference,
        amountCents: claimed.intent.amountCents, payerEmail,
        description: 'Participação na partida de Free Fire',
      });
    } catch (error) {
      const rejectedBeforeCreate = error instanceof DomainError && ['MP_INVALID_REFERENCE', 'MP_INVALID_KEY', 'MP_INVALID_AMOUNT', 'MP_INVALID_PAYER', 'MP_INVALID_DESCRIPTION', 'MP_INVALID_EXPIRATION', 'PAYMENT_NOT_CREATED'].includes(error.code);
      this.store.transaction(() => {
        const current = this.raw(prepared.id, guildId);
        if (current.status === 'creating') {
          current.status = rejectedBeforeCreate ? 'prepared' : 'uncertain';
          current.reviewReason = rejectedBeforeCreate ? 'CREATE_NOT_SENT_OR_REJECTED' : 'CREATE_RESPONSE_UNCERTAIN';
          this.save(current); this.audit(current, 'pix_charge_uncertain');
        }
      });
      if (rejectedBeforeCreate) throw new DomainError('PIX_CREATE_REJECTED', 'A cobrança não foi criada. Corrija os dados ou a configuração antes de tentar novamente.');
      throw new DomainError('PIX_CREATION_UNCERTAIN', `A criação da cobrança ${prepared.id} ficou incerta. Não foi repetida. Sem ID remoto, é necessária revisão com o provedor.`);
    }
    return this.applyPayment(prepared.id, payment);
  }

  get(guildId: string, id: string, actor: Actor): BillingIntent {
    const intent = this.raw(id, guildId); this.authorize(intent, actor); return intent;
  }

  async reconcile(guildId: string, id: string, actor: Actor): Promise<BillingIntent> {
    const intent = this.get(guildId, id, actor);
    this.sameAccount(intent);
    return this.reconcilePending(intent.id);
  }

  /** Internal worker/webhook entry point. Only use after authenticating a webhook. */
  async reconcilePending(id: string): Promise<BillingIntent> {
    requireCondition(!this.store.db.isTransaction, 'PIX_TRANSACTION', 'Não mantenha uma transação de banco aberta durante a chamada ao provedor.');
    const intent = this.raw(id); this.sameAccount(intent);
    requireCondition(intent.remoteId || this.gateway.findPaymentByReference, 'PIX_REMOTE_ID_UNKNOWN', 'O provedor não retornou um ID remoto. Não repita a criação; revise a cobrança diretamente no provedor.');
    let payment: PixPayment | undefined;
    try { payment = intent.remoteId ? await this.gateway.getPayment(intent.remoteId) : await this.gateway.findPaymentByReference!(intent.reference); }
    catch { throw new DomainError('PIX_LOOKUP_FAILED', 'Não foi possível consultar o provedor. Nenhum pagamento foi confirmado por esse erro.'); }
    if (!payment) return intent;
    return this.applyPayment(id, payment);
  }

  private applyPayment(id: string, payment: PixPayment): BillingIntent {
    let issue: string | undefined;
    let result: BillingIntent;
    try {
      result = this.store.transaction(() => {
        const current = this.raw(id); this.sameAccount(current);
        const remoteIdValid = typeof payment.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(payment.id);
        const refunded = payment.refundedCents ?? 0;
        if (!remoteIdValid || !statuses.has(payment.status) || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > current.amountCents) issue = 'INVALID_PROVIDER_RESPONSE';
        else if (current.remoteId && payment.id !== current.remoteId) issue = 'REMOTE_ID_MISMATCH';
        else if (payment.externalReference !== current.reference) issue = 'REFERENCE_MISMATCH';
        else if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents !== current.amountCents) issue = 'AMOUNT_MISMATCH';
        else if (this.store.db.prepare('SELECT 1 FROM billing_intents WHERE provider=? AND provider_identity=? AND remote_id=? AND id!=?')
          .get(current.provider, current.providerIdentity, payment.id, current.id)) issue = 'REMOTE_PAYMENT_REUSED';
        for (const [value, max] of [[payment.pixCopyPaste, 8192], [payment.qrCode, 750_000], [payment.expiresAt, 100]] as const) {
          if (value !== undefined && (typeof value !== 'string' || value.length > max)) issue = 'INVALID_PROVIDER_RESPONSE';
        }
        if (issue) {
          current.status = 'review'; current.reviewReason = issue;
          // A safe remote ID is retained for canonical lookup; never replace an existing ID.
          if (!current.remoteId && remoteIdValid && issue !== 'REMOTE_PAYMENT_REUSED') current.remoteId = payment.id;
          delete current.pixCopyPaste; delete current.qrCode;
          this.save(current); this.audit(current, 'pix_charge_review'); return current;
        }
        current.remoteId = payment.id; current.remoteStatus = payment.status;
        if (payment.pixCopyPaste !== undefined) current.pixCopyPaste = payment.pixCopyPaste;
        if (payment.qrCode !== undefined) current.qrCode = payment.qrCode;
        if (payment.expiresAt !== undefined) current.expiresAt = payment.expiresAt;
        if (payment.status === 'refunded' || refunded > 0) {
          current.status = refunded === current.amountCents || payment.status === 'refunded' ? 'refunded' : 'review';
          current.reviewReason = current.creditedAt === null ? 'REMOTE_REFUND' : 'REMOTE_REFUND_AFTER_CREDIT';
          delete current.pixCopyPaste; delete current.qrCode;
        } else if (payment.status === 'approved') {
          if (current.reviewReason === 'REMOTE_REFUND_AFTER_CREDIT' || current.reviewReason === 'REMOTE_REFUND') {
            // A delayed approved response must not undo an observed refund.
            current.status = 'review';
          } else {
            this.payments.confirmProviderReceipt(current.guildId, current.matchId, current.userId,
              current.amountCents, current.provider, payment.id);
            current.status = 'approved'; current.creditedAt ??= this.now(); delete current.reviewReason;
          }
        } else if (current.creditedAt === null) {
          current.status = payment.status === 'unknown' ? 'uncertain' : payment.status;
          delete current.reviewReason;
        } else if (payment.status !== 'pending' && payment.status !== 'unknown') {
          current.status = 'review'; current.reviewReason = 'REMOTE_STATUS_AFTER_CREDIT';
        }
        // Once credited, late pending/cancelled responses cannot silently erase a receipt.
        this.save(current); this.audit(current, `pix_charge_${current.status}`); return current;
      });
    } catch (error) {
      // The receipt and approval transaction has rolled back in full. Persist only
      // a review marker in a new transaction; never commit a partial ledger entry.
      if (error instanceof DomainError && error.code === 'PIX_PROVIDER_CHANGED') throw error;
      this.store.transaction(() => {
        const current = this.raw(id); current.status = 'review'; current.reviewReason = 'RECEIPT_RECORD_FAILED';
        if (!current.remoteId && payment && /^[A-Za-z0-9_-]{1,80}$/.test(payment.id)
          && !this.store.db.prepare('SELECT 1 FROM billing_intents WHERE provider=? AND provider_identity=? AND remote_id=? AND id!=?')
            .get(current.provider, current.providerIdentity, payment.id, current.id)) current.remoteId = payment.id;
        this.save(current); this.audit(current, 'pix_charge_review');
      });
      throw new DomainError('PIX_REVIEW_REQUIRED', 'O pagamento exige revisão de conciliação. Nenhum crédito parcial foi confirmado por essa tentativa.');
    }
    if (issue) throw new DomainError('PIX_PAYMENT_MISMATCH', 'A resposta do provedor não corresponde à cobrança. Nenhum recebimento foi creditado por essa tentativa.');
    return result;
  }

  /** Internal read model; callers must not expose other participants' PIX codes. */
  pending(limit = 100): BillingIntent[] {
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'PIX_LIMIT', 'Limite de cobranças inválido.');
    return (this.store.db.prepare(`SELECT payload FROM billing_intents WHERE provider=? AND provider_identity=?
      AND (remote_id IS NOT NULL OR ?=1)
      AND (status IN ('creating','pending','uncertain') OR (status='approved' AND updated_at<? AND created_at>?))
      ORDER BY updated_at,id LIMIT ?`)
      .all(this.gateway.name, this.gateway.identity, this.gateway.findPaymentByReference ? 1 : 0, this.now() - 60_000, this.now() - 86_400_000, limit) as Row[]).map(row => JSON.parse(row.payload) as BillingIntent);
  }

  /** Internal lookup for an already authenticated provider event; GET still required. */
  findByRemoteId(remoteId: string): BillingIntent | undefined {
    const row = this.store.db.prepare('SELECT payload FROM billing_intents WHERE provider=? AND provider_identity=? AND remote_id=?')
      .get(this.gateway.name, this.gateway.identity, remoteId) as Row | undefined;
    return row ? JSON.parse(row.payload) as BillingIntent : undefined;
  }

  /** Match-level hold; includes old account bindings so rotation cannot hide a review. */
  assertNoFinancialReview(guildId: string, matchId: string): void {
    const blocked = this.store.db.prepare(`SELECT 1 FROM billing_intents WHERE guild_id=? AND match_id=?
      AND (status='review' OR (status='refunded' AND json_extract(payload,'$.creditedAt') IS NOT NULL)) LIMIT 1`)
      .get(guildId, matchId);
    requireCondition(!blocked, 'PIX_FINANCIAL_REVIEW', 'Há uma cobrança em revisão ou estorno remoto pendente de conciliação. Não inicie nem liquide a partida antes da revisão financeira.');
  }
}
