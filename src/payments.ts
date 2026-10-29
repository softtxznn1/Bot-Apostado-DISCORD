import { randomUUID } from 'node:crypto';
import { Store } from './database.js';
import { requireCondition, type Actor, type Match } from './domain.js';
import { BotService } from './service.js';

/** Registro de conferências e transferências MANUAIS. Não consulta banco nem movimenta fundos. */
export type FinancePlan = {
  guildId: string; matchId: string; stakeCents: number; feeBasisPoints: number;
  expectedTotalCents: number; feeCents: number; prizeCents: number;
  createdBy: string; createdAt: number;
};
export type FinancePlayer = {
  userId: string; team: 1 | 2; amountDueCents: number; receivedCents: number;
  refundedCents: number; prizeDueCents: number; prizePaidCents: number;
};
export type FinanceSummary = {
  plan: FinancePlan; players: FinancePlayer[]; receivedCents: number; refundedCents: number;
  prizesPaidCents: number; feesPaidCents: number; recordedCustodyCents: number;
  status: 'collecting' | 'funded' | 'awaiting_settlement' | 'settled' | 'refunding' | 'refunded';
  source: 'manual_records' | 'provider_records' | 'mixed_records';
};
export type ManualMovement = {
  id: string; guildId: string; matchId: string; kind: 'receipt' | 'refund' | 'prize' | 'fee';
  userId: string; amountCents: number; reference: string; actorId: string; createdAt: number;
  source?: 'manual' | 'provider'; provider?: 'mercadopago' | 'efi';
};
type PlanRow = { payload: string };
type OpRow = { payload: string; request: string };
type MovementKind = ManualMovement['kind'];

const schema = `
  CREATE TABLE finance_plans (
    guild_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id), payload TEXT NOT NULL,
    PRIMARY KEY(guild_id,match_id)
  );
  CREATE TABLE finance_operations (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id),
    kind TEXT NOT NULL CHECK(kind IN ('receipt','refund','prize','fee')),
    user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    reference TEXT NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(guild_id,idempotency_key), UNIQUE(guild_id,reference), UNIQUE(guild_id,match_id,kind,user_id)
  );
  CREATE TABLE finance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES finance_operations(id),
    account TEXT NOT NULL, signed_cents INTEGER NOT NULL CHECK(signed_cents != 0),
    UNIQUE(operation_id,account)
  );
  CREATE INDEX finance_operations_match ON finance_operations(guild_id,match_id);
  CREATE TRIGGER finance_plans_no_update BEFORE UPDATE ON finance_plans BEGIN SELECT RAISE(ABORT,'finance plans are immutable'); END;
  CREATE TRIGGER finance_plans_no_delete BEFORE DELETE ON finance_plans BEGIN SELECT RAISE(ABORT,'finance plans are immutable'); END;
  CREATE TRIGGER finance_operations_no_update BEFORE UPDATE ON finance_operations BEGIN SELECT RAISE(ABORT,'finance operations are append-only'); END;
  CREATE TRIGGER finance_operations_no_delete BEFORE DELETE ON finance_operations BEGIN SELECT RAISE(ABORT,'finance operations are append-only'); END;
  CREATE TRIGGER finance_entries_no_update BEFORE UPDATE ON finance_entries BEGIN SELECT RAISE(ABORT,'finance entries are append-only'); END;
  CREATE TRIGGER finance_entries_no_delete BEFORE DELETE ON finance_entries BEGIN SELECT RAISE(ABORT,'finance entries are append-only'); END;
`;

function integerCents(value: number): void {
  requireCondition(Number.isSafeInteger(value) && value > 0, 'INVALID_AMOUNT', 'O valor precisa ser um inteiro positivo em centavos.');
}
function normalizeReference(value: string): string {
  const normalized = value.trim();
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$/.test(normalized), 'INVALID_REFERENCE', 'Use uma referência não secreta de 3 a 120 letras, números, ponto, :, /, _ ou -.');
  return normalized;
}

export class PaymentsService {
  constructor(readonly store: Store, private readonly matches: BotService, private readonly now = Date.now) {
    store.migrateFeature('payments', 1, schema);
  }

  private operator(match: Match, actor: Actor): void {
    requireCondition(actor.moderator || (actor.mediator && match.mediatorId === actor.userId), 'FORBIDDEN', 'Somente o mediador atribuído ou a moderação pode registrar conferências financeiras.');
  }
  private getPlan(guildId: string, matchId: string): FinancePlan {
    const row = this.store.db.prepare('SELECT payload FROM finance_plans WHERE guild_id=? AND match_id=?').get(guildId, matchId) as PlanRow | undefined;
    requireCondition(row, 'FINANCE_NOT_CONFIGURED', 'A partida ainda não possui plano financeiro.');
    return JSON.parse(row.payload) as FinancePlan;
  }

  configurePlan(guildId: string, matchId: string, actor: Actor, feeBasisPoints: number): FinancePlan {
    requireCondition(Number.isInteger(feeBasisPoints) && feeBasisPoints >= 0 && feeBasisPoints <= 10_000, 'INVALID_FEE', 'A taxa deve ser um inteiro de 0 a 10000 pontos-base (100 pontos-base = 1%).');
    return this.store.transaction(() => {
      const match = this.matches.match(guildId, matchId); this.operator(match, actor);
      const existing = this.store.db.prepare('SELECT payload FROM finance_plans WHERE guild_id=? AND match_id=?').get(guildId, matchId) as PlanRow | undefined;
      if (existing) {
        const plan = JSON.parse(existing.payload) as FinancePlan;
        requireCondition(plan.feeBasisPoints === feeBasisPoints, 'PLAN_IMMUTABLE', 'A taxa já foi fixada. Encerre a partida e crie outra para pactuar novas condições.');
        return plan;
      }
      requireCondition(match.state === 'ready', 'INVALID_STATE', 'Configure a taxa após atribuir o mediador e antes de criar a sala.');
      integerCents(match.stakeCents);
      const total = BigInt(match.stakeCents) * BigInt(match.players.length);
      requireCondition(total <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_AMOUNT', 'O total da partida excede o limite de inteiros seguros.');
      const expectedTotalCents = Number(total);
      const feeCents = Number(total * BigInt(feeBasisPoints) / 10_000n);
      const plan: FinancePlan = { guildId, matchId, stakeCents: match.stakeCents, feeBasisPoints,
        expectedTotalCents, feeCents, prizeCents: expectedTotalCents - feeCents, createdBy: actor.userId, createdAt: this.now() };
      this.store.db.prepare('INSERT INTO finance_plans(guild_id,match_id,payload) VALUES(?,?,?)').run(guildId, matchId, JSON.stringify(plan));
      this.store.db.prepare('INSERT INTO audit(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
        .run(guildId, matchId, actor.userId, 'manual_finance_configured', this.now(), JSON.stringify({ feeBasisPoints, expectedTotalCents, feeCents }));
      return plan;
    });
  }

  /** Apenas uma instrução de conferência; não gera PIX nem envia cobrança ao banco. */
  charge(guildId: string, matchId: string, actor: Actor, userId = actor.userId): { userId: string; amountCents: number; plan: FinancePlan; source: 'manual_records' } {
    const match = this.matches.viewMatch(guildId, matchId, actor);
    if (userId !== actor.userId) this.operator(match, actor);
    requireCondition(match.players.some(p => p.userId === userId), 'NOT_PARTICIPANT', 'O jogador informado não participa desta partida.');
    requireCondition(match.state === 'ready' || match.state === 'room_created', 'INVALID_STATE', 'A conferência de pagamento não está disponível neste estado.');
    const plan = this.getPlan(guildId, matchId);
    return { userId, amountCents: plan.stakeCents, plan, source: 'manual_records' };
  }

  confirmReceipt(guildId: string, matchId: string, actor: Actor, userId: string, amountCents: number, reference: string, idempotencyKey: string): ManualMovement {
    return this.record(guildId, matchId, actor, 'receipt', userId, amountCents, reference, idempotencyKey);
  }
  refund(guildId: string, matchId: string, actor: Actor, userId: string, amountCents: number, reference: string, idempotencyKey: string): ManualMovement {
    return this.record(guildId, matchId, actor, 'refund', userId, amountCents, reference, idempotencyKey);
  }
  payPrize(guildId: string, matchId: string, actor: Actor, userId: string, amountCents: number, reference: string, idempotencyKey: string): ManualMovement {
    return this.record(guildId, matchId, actor, 'prize', userId, amountCents, reference, idempotencyKey);
  }
  payFee(guildId: string, matchId: string, actor: Actor, amountCents: number, reference: string, idempotencyKey: string): ManualMovement {
    return this.record(guildId, matchId, actor, 'fee', 'house', amountCents, reference, idempotencyKey);
  }
  /** Internal trust boundary: call only after validating an authenticated provider response. */
  confirmProviderReceipt(guildId: string, matchId: string, userId: string, amountCents: number, provider: 'mercadopago' | 'efi', remoteId: string): ManualMovement {
    requireCondition(provider === 'mercadopago' || provider === 'efi', 'INVALID_PROVIDER', 'Provedor financeiro inválido.');
    requireCondition(/^[A-Za-z0-9_-]{1,80}$/.test(remoteId), 'INVALID_REFERENCE', 'Identificador do pagamento inválido.');
    const reference = `${provider}:${remoteId}`;
    return this.record(guildId, matchId, { userId: `provider:${provider}`, moderator: true, mediator: false }, 'receipt', userId, amountCents, reference, reference, provider);
  }

  private record(guildId: string, matchId: string, actor: Actor, kind: MovementKind, userId: string, amountCents: number, reference: string, idempotencyKey: string, provider?: 'mercadopago' | 'efi'): ManualMovement {
    integerCents(amountCents);
    reference = normalizeReference(reference);
    requireCondition(typeof idempotencyKey === 'string' && idempotencyKey.length >= 3 && idempotencyKey.length <= 200, 'INVALID_OPERATION_KEY', 'A chave de operação precisa ter de 3 a 200 caracteres.');
    const operation = () => {
      const match = this.matches.match(guildId, matchId); this.operator(match, actor);
      const request = JSON.stringify({ matchId, kind, userId, amountCents, reference, actorId: actor.userId });
      const prior = this.store.db.prepare('SELECT payload,request FROM finance_operations WHERE guild_id=? AND idempotency_key=?').get(guildId, idempotencyKey) as OpRow | undefined;
      if (prior) {
        requireCondition(prior.request === request, 'IDEMPOTENCY_CONFLICT', 'Essa chave de operação já foi usada com outros dados.');
        return JSON.parse(prior.payload) as ManualMovement;
      }
      requireCondition(!this.store.db.prepare('SELECT 1 FROM finance_operations WHERE guild_id=? AND reference=?').get(guildId, reference), 'REFERENCE_REUSED', 'Essa referência de transferência já foi registrada. Nenhum novo lançamento foi criado.');
      const plan = this.getPlan(guildId, matchId);
      const summary = this.summaryUnchecked(match, plan);
      const player = summary.players.find(p => p.userId === userId);
      requireCondition(kind === 'fee' || player, 'NOT_PARTICIPANT', 'O jogador informado não participa desta partida.');
      requireCondition(!this.store.db.prepare('SELECT 1 FROM finance_operations WHERE guild_id=? AND match_id=? AND kind=? AND user_id=?').get(guildId, matchId, kind, userId), 'ALREADY_RECORDED', 'Essa movimentação já foi registrada para o destinatário.');
      if (kind === 'receipt') {
        requireCondition(provider || match.state === 'ready' || match.state === 'room_created', 'INVALID_STATE', 'Pagamentos manuais só podem ser conferidos antes de iniciar a partida.');
        requireCondition(amountCents === plan.stakeCents, 'AMOUNT_MISMATCH', 'O valor recebido deve corresponder exatamente ao combinado por jogador.');
      } else if (kind === 'refund') {
        requireCondition(match.state === 'cancelled' || match.state === 'expired', 'INVALID_STATE', 'Estorno exige uma partida cancelada ou expirada.');
        requireCondition(player!.receivedCents === plan.stakeCents && player!.refundedCents === 0, 'NOT_PAID', 'Não existe recebimento pendente de estorno para esse jogador.');
        requireCondition(summary.prizesPaidCents === 0 && summary.feesPaidCents === 0, 'ALREADY_SETTLED', 'Há saídas de prêmio ou taxa; este fluxo não permite estorno automático.');
        requireCondition(amountCents === plan.stakeCents, 'AMOUNT_MISMATCH', 'Registre o estorno integral do valor conferido.');
      } else {
        requireCondition(match.state === 'finished' && match.result, 'INVALID_STATE', 'Prêmio e taxa só podem ser registrados após o encerramento definitivo do resultado.');
        requireCondition(summary.receivedCents === plan.expectedTotalCents && summary.refundedCents === 0, 'NOT_FUNDED', 'Todos os pagamentos precisam estar conferidos e sem estornos.');
        if (kind === 'prize') requireCondition(player!.prizeDueCents > 0 && amountCents === player!.prizeDueCents, 'AMOUNT_MISMATCH', 'O prêmio deve corresponder exatamente à parcela calculada do jogador vencedor.');
        else requireCondition(plan.feeCents > 0 && amountCents === plan.feeCents, 'AMOUNT_MISMATCH', 'A taxa deve corresponder exatamente ao valor fixado no plano.');
      }
      if (kind !== 'receipt') requireCondition(amountCents <= summary.recordedCustodyCents, 'INSUFFICIENT_RECORDED_CUSTODY', 'O registro de custódia é insuficiente para essa saída.');
      const movement: ManualMovement = { id: randomUUID(), guildId, matchId, kind, userId, amountCents, reference, actorId: actor.userId, createdAt: this.now(), source: provider ? 'provider' : 'manual', ...(provider ? { provider } : {}) };
      this.store.db.prepare('INSERT INTO finance_operations(id,guild_id,match_id,kind,user_id,amount_cents,reference,idempotency_key,request,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(movement.id, guildId, matchId, kind, userId, amountCents, reference, idempotencyKey, request, JSON.stringify(movement), movement.createdAt);
      const sign = kind === 'receipt' ? 1 : -1;
      const entries: [string, number][] = [['custody', sign * amountCents], [kind === 'fee' ? 'external:house' : `external:${userId}`, -sign * amountCents]];
      requireCondition(entries.reduce((sum, [, amount]) => sum + amount, 0) === 0, 'UNBALANCED_LEDGER', 'Lançamento não balanceado.');
      const insert = this.store.db.prepare('INSERT INTO finance_entries(operation_id,account,signed_cents) VALUES(?,?,?)');
      for (const [account, cents] of entries) insert.run(movement.id, account, cents);
      this.store.db.prepare('INSERT INTO audit(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
        .run(guildId, matchId, actor.userId, `${provider ? 'provider' : 'manual'}_finance_${kind}`, movement.createdAt, JSON.stringify({ operationId: movement.id, userId, amountCents, ...(provider ? { provider } : {}) }));
      return movement;
    };
    return this.store.db.isTransaction ? operation() : this.store.transaction(operation);
  }

  private summaryUnchecked(match: Match, plan: FinancePlan): FinanceSummary {
    const movements = (this.store.db.prepare('SELECT payload FROM finance_operations WHERE guild_id=? AND match_id=? ORDER BY created_at,id').all(match.guildId, match.id) as PlanRow[])
      .map(r => JSON.parse(r.payload) as ManualMovement);
    const winningTeam = match.state === 'finished' ? match.result?.decision?.winner ?? match.result?.winner : undefined;
    const winners = match.players.filter(p => p.team === winningTeam);
    const prizeBase = winners.length ? Math.floor(plan.prizeCents / winners.length) : 0;
    const prizeRemainder = winners.length ? plan.prizeCents % winners.length : 0;
    const sum = (kind: MovementKind, userId?: string) => movements.filter(m => m.kind === kind && (userId === undefined || m.userId === userId)).reduce((total, m) => total + m.amountCents, 0);
    const players = match.players.map(p => {
      const index = winners.findIndex(w => w.userId === p.userId);
      return { userId: p.userId, team: p.team, amountDueCents: plan.stakeCents,
        receivedCents: sum('receipt', p.userId), refundedCents: sum('refund', p.userId),
        prizeDueCents: index < 0 ? 0 : prizeBase + (index < prizeRemainder ? 1 : 0), prizePaidCents: sum('prize', p.userId) };
    });
    const receivedCents = sum('receipt'); const refundedCents = sum('refund');
    const prizesPaidCents = sum('prize'); const feesPaidCents = sum('fee');
    let status: FinanceSummary['status'] = receivedCents === plan.expectedTotalCents ? match.state === 'finished' ? 'awaiting_settlement' : 'funded' : 'collecting';
    if (match.state === 'cancelled' || match.state === 'expired') status = receivedCents === refundedCents ? 'refunded' : 'refunding';
    else if (match.state === 'finished' && receivedCents === plan.expectedTotalCents && prizesPaidCents === plan.prizeCents && feesPaidCents === plan.feeCents) status = 'settled';
    const providerRecords = movements.some(m => m.source === 'provider');
    const manualRecords = movements.some(m => m.source !== 'provider');
    return { plan, players, receivedCents, refundedCents, prizesPaidCents, feesPaidCents,
      recordedCustodyCents: receivedCents - refundedCents - prizesPaidCents - feesPaidCents, status,
      source: providerRecords ? manualRecords ? 'mixed_records' : 'provider_records' : 'manual_records' };
  }
  summary(guildId: string, matchId: string, actor: Actor): FinanceSummary {
    const match = this.matches.viewMatch(guildId, matchId, actor);
    return this.summaryUnchecked(match, this.getPlan(guildId, matchId));
  }
  report(guildId: string, actor: Actor): FinanceSummary[] {
    requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a moderação pode consultar o relatório financeiro do servidor.');
    return (this.store.db.prepare('SELECT match_id FROM finance_plans WHERE guild_id=? ORDER BY match_id').all(guildId) as { match_id: string }[])
      .map(r => this.summary(guildId, r.match_id, actor));
  }
  history(guildId: string, matchId: string, actor: Actor): ManualMovement[] {
    const match = this.matches.match(guildId, matchId); this.operator(match, actor);
    return (this.store.db.prepare('SELECT payload FROM finance_operations WHERE guild_id=? AND match_id=? ORDER BY created_at,id').all(guildId, matchId) as PlanRow[])
      .map(row => JSON.parse(row.payload) as ManualMovement);
  }
  assertFundedForPlay(guildId: string, matchId: string): void {
    const match = this.matches.match(guildId, matchId);
    const row = this.store.db.prepare('SELECT payload FROM finance_plans WHERE guild_id=? AND match_id=?').get(guildId, matchId) as PlanRow | undefined;
    // Sem plano, a partida continua no fluxo informativo, sem movimentação pelo bot.
    if (!row) return;
    const summary = this.summaryUnchecked(match, JSON.parse(row.payload) as FinancePlan);
    requireCondition(summary.receivedCents === summary.plan.expectedTotalCents && summary.refundedCents === 0, 'NOT_FUNDED', 'Confirme todos os pagamentos do plano antes de iniciar o jogo.');
  }
  assertReadyForRoom(guildId: string, matchId: string): void { this.assertFundedForPlay(guildId, matchId); }
}
