import { randomUUID } from 'node:crypto';
import { requireCondition, type Actor } from './domain.js';
import type { Store } from './database.js';
import type { BotService } from './service.js';

export type OperationsActor = Actor & { analyst?: boolean };
export type DutyKind = 'mediator' | 'analyst';
export type Duty = { guildId: string; userId: string; kind: DutyKind; startedAt: number; expiresAt: number; active: boolean };
export type Ticket = {
  id: string; guildId: string; ownerId: string; title: string; description: string;
  state: 'open' | 'claimed' | 'closed'; assignedTo: string | null;
  createdAt: number; closedAt: number | null; closeReason: string | null;
  channelId: string | null; messageId: string | null;
};
export type AnalysisOutcome = 'approved' | 'irregularity' | 'inconclusive';
export type Analysis = {
  id: string; guildId: string; matchId: string; requesterId: string; subjectId: string;
  reason: string; evidenceUrl: string | null; state: 'open' | 'claimed' | 'completed';
  assignedTo: string | null; createdAt: number; completedAt: number | null;
  outcome: AnalysisOutcome | null; decisionReason: string | null;
};
export type TicketSummary = Pick<Ticket, 'id' | 'ownerId' | 'title' | 'state' | 'assignedTo' | 'createdAt'>;
export type AnalysisSummary = Pick<Analysis, 'id' | 'matchId' | 'state' | 'assignedTo' | 'createdAt'>;
export type Profile = {
  userId: string; wins: number; losses: number; played: number; winRate: number;
  active?: { queueId: string | null; matchId: string | null } | null;
  ticketsOpened?: number;
};
type JsonRow = { payload: string };

const schema = `
  CREATE TABLE operations_tickets (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(guild_id), owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','claimed','closed')), assigned_to TEXT,
    payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX operations_one_active_ticket ON operations_tickets(guild_id,owner_id) WHERE state != 'closed';
  CREATE INDEX operations_ticket_guild_state ON operations_tickets(guild_id,state);
  CREATE TABLE operations_duties (
    guild_id TEXT NOT NULL REFERENCES guilds(guild_id), user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mediator','analyst')), started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
    PRIMARY KEY(guild_id,user_id,kind)
  );
  CREATE TABLE operations_analyses (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL REFERENCES guilds(guild_id), match_id TEXT NOT NULL REFERENCES matches(id),
    requester_id TEXT NOT NULL, subject_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','claimed','completed')), assigned_to TEXT, payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX operations_one_active_analysis ON operations_analyses(guild_id,match_id,subject_id) WHERE state != 'completed';
  CREATE INDEX operations_analysis_guild_state ON operations_analyses(guild_id,state);
  CREATE TABLE operations_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL
  );
`;

export class OperationsService {
  constructor(readonly store: Store, private readonly bot: BotService, private readonly now = Date.now) {
    store.migrateFeature('operations', 1, schema);
  }

  private configured(guild: string): void {
    requireCondition(this.bot.config(guild), 'NOT_CONFIGURED', 'Configure o servidor com /configurar antes de usar este recurso.');
  }
  private event(guild: string, subject: string, actor: string, action: string, details: Record<string, unknown> = {}): void {
    this.store.db.prepare('INSERT INTO operations_events(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
      .run(guild, subject, actor, action, this.now(), JSON.stringify(details));
  }
  private operator(actor: OperationsActor): boolean { return actor.moderator || actor.mediator; }
  private text(value: string, minimum: number, maximum: number, name: string): string {
    requireCondition(typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum,
      'INVALID_TEXT', `${name}: informe entre ${minimum} e ${maximum} caracteres.`);
    return value.trim();
  }
  private ticketRecord(guild: string, id: string): Ticket {
    const row = this.store.db.prepare('SELECT payload FROM operations_tickets WHERE guild_id=? AND id=?').get(guild, id) as JsonRow | undefined;
    requireCondition(row, 'NOT_FOUND', 'Ticket não encontrado neste servidor.');
    return JSON.parse(row.payload) as Ticket;
  }
  private saveTicket(t: Ticket): Ticket {
    this.store.db.prepare('UPDATE operations_tickets SET state=?,assigned_to=?,payload=? WHERE guild_id=? AND id=?')
      .run(t.state, t.assignedTo, JSON.stringify(t), t.guildId, t.id);
    return t;
  }
  private canReadTicket(t: Ticket, actor: OperationsActor): boolean {
    return actor.moderator || actor.userId === t.ownerId || (actor.userId === t.assignedTo && this.operator(actor));
  }

  openTicket(guild: string, actor: OperationsActor, title: string, description: string): Ticket {
    this.configured(guild);
    title = this.text(title, 3, 100, 'Título'); description = this.text(description, 5, 1500, 'Descrição');
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT payload FROM operations_tickets WHERE guild_id=? AND owner_id=? AND state!='closed'").get(guild, actor.userId) as JsonRow | undefined;
      if (row) return JSON.parse(row.payload) as Ticket;
      const ticket: Ticket = {
        id: randomUUID(), guildId: guild, ownerId: actor.userId, title, description,
        state: 'open', assignedTo: null, createdAt: this.now(), closedAt: null, closeReason: null,
        channelId: null, messageId: null,
      };
      this.store.db.prepare('INSERT INTO operations_tickets(id,guild_id,owner_id,state,assigned_to,payload) VALUES(?,?,?,?,?,?)')
        .run(ticket.id, guild, actor.userId, ticket.state, null, JSON.stringify(ticket));
      this.event(guild, ticket.id, actor.userId, 'ticket_opened');
      return ticket;
    });
  }
  ticket(guild: string, id: string, actor: OperationsActor): Ticket {
    const ticket = this.ticketRecord(guild, id);
    requireCondition(this.canReadTicket(ticket, actor), 'FORBIDDEN', 'Você não tem acesso a este ticket.');
    return ticket;
  }
  tickets(guild: string, actor: OperationsActor): TicketSummary[] {
    this.configured(guild);
    const rows = this.store.db.prepare('SELECT payload FROM operations_tickets WHERE guild_id=? ORDER BY rowid DESC LIMIT 200').all(guild) as JsonRow[];
    return rows.map(r => JSON.parse(r.payload) as Ticket)
      .filter(t => this.canReadTicket(t, actor) || (this.operator(actor) && t.state === 'open'))
      .map(({ id, ownerId, title, state, assignedTo, createdAt }) => ({ id, ownerId, title, state, assignedTo, createdAt }));
  }
  claimTicket(guild: string, id: string, actor: OperationsActor): Ticket {
    requireCondition(this.operator(actor), 'FORBIDDEN', 'Somente a staff ou um mediador pode assumir tickets.');
    return this.store.transaction(() => {
      const ticket = this.ticketRecord(guild, id);
      if (ticket.state === 'claimed' && ticket.assignedTo === actor.userId) return ticket;
      requireCondition(ticket.state === 'open', 'INVALID_STATE', 'Este ticket já foi assumido ou encerrado.');
      ticket.state = 'claimed'; ticket.assignedTo = actor.userId;
      this.event(guild, id, actor.userId, 'ticket_claimed');
      return this.saveTicket(ticket);
    });
  }
  closeTicket(guild: string, id: string, actor: OperationsActor, reason: string): Ticket {
    reason = this.text(reason, 3, 300, 'Motivo');
    return this.store.transaction(() => {
      const ticket = this.ticketRecord(guild, id);
      requireCondition(this.canReadTicket(ticket, actor), 'FORBIDDEN', 'Somente o solicitante, o atendente ou a moderação pode encerrar este ticket.');
      if (ticket.state === 'closed') return ticket;
      ticket.state = 'closed'; ticket.closedAt = this.now(); ticket.closeReason = reason;
      this.event(guild, id, actor.userId, 'ticket_closed', { reason });
      return this.saveTicket(ticket);
    });
  }
  attachTicketChannel(guild: string, id: string, channelId: string, messageId: string | null): Ticket {
    return this.store.transaction(() => {
      const ticket = this.ticketRecord(guild, id);
      ticket.channelId = channelId; ticket.messageId = messageId;
      return this.saveTicket(ticket);
    });
  }
  // Uso interno do reconciliador; não expor esse retorno em respostas públicas.
  ticketsForReconciliation(guild: string): Ticket[] {
    return (this.store.db.prepare('SELECT payload FROM operations_tickets WHERE guild_id=?').all(guild) as JsonRow[])
      .map(r => JSON.parse(r.payload) as Ticket);
  }

  enterDuty(guild: string, actor: OperationsActor, kind: DutyKind, minutes = 240): Duty {
    this.configured(guild);
    requireCondition(kind === 'mediator' || kind === 'analyst', 'INVALID_DUTY', 'Tipo de plantão inválido.');
    requireCondition(actor.moderator || (kind === 'mediator' ? actor.mediator : actor.analyst), 'FORBIDDEN', 'Seu cargo não permite esse tipo de plantão.');
    requireCondition(Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440, 'INVALID_DURATION', 'O plantão deve durar de 15 a 1440 minutos.');
    return this.store.transaction(() => {
      const duty: Duty = { guildId: guild, userId: actor.userId, kind, startedAt: this.now(), expiresAt: this.now() + minutes * 60_000, active: true };
      this.store.db.prepare('INSERT INTO operations_duties(guild_id,user_id,kind,started_at,expires_at,active) VALUES(?,?,?,?,?,1) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET started_at=excluded.started_at,expires_at=excluded.expires_at,active=1')
        .run(guild, actor.userId, kind, duty.startedAt, duty.expiresAt);
      this.event(guild, actor.userId, actor.userId, 'duty_started', { kind, expiresAt: duty.expiresAt });
      return duty;
    });
  }
  leaveDuty(guild: string, actor: OperationsActor, kind: DutyKind): void {
    this.configured(guild);
    requireCondition(kind === 'mediator' || kind === 'analyst', 'INVALID_DUTY', 'Tipo de plantão inválido.');
    this.store.transaction(() => {
      const result = this.store.db.prepare('UPDATE operations_duties SET active=0 WHERE guild_id=? AND user_id=? AND kind=? AND active=1').run(guild, actor.userId, kind);
      if (result.changes) this.event(guild, actor.userId, actor.userId, 'duty_ended', { kind });
    });
  }
  expireDuties(): number {
    return this.store.transaction(() => {
      const rows = this.store.db.prepare('SELECT guild_id,user_id,kind FROM operations_duties WHERE active=1 AND expires_at<=?').all(this.now()) as { guild_id: string; user_id: string; kind: DutyKind }[];
      for (const row of rows) this.event(row.guild_id, row.user_id, 'system', 'duty_expired', { kind: row.kind });
      this.store.db.prepare('UPDATE operations_duties SET active=0 WHERE active=1 AND expires_at<=?').run(this.now());
      return rows.length;
    });
  }
  duties(guild: string, actor: OperationsActor): Duty[] {
    requireCondition(this.operator(actor) || actor.analyst, 'FORBIDDEN', 'Somente a equipe pode consultar plantões.');
    this.configured(guild); this.expireDuties();
    const rows = this.store.db.prepare('SELECT * FROM operations_duties WHERE guild_id=? AND active=1 ORDER BY started_at').all(guild) as { guild_id: string; user_id: string; kind: DutyKind; started_at: number; expires_at: number; active: number }[];
    return rows.map(r => ({ guildId: r.guild_id, userId: r.user_id, kind: r.kind, startedAt: r.started_at, expiresAt: r.expires_at, active: r.active === 1 }));
  }

  private analysisRecord(guild: string, id: string): Analysis {
    const row = this.store.db.prepare('SELECT payload FROM operations_analyses WHERE guild_id=? AND id=?').get(guild, id) as JsonRow | undefined;
    requireCondition(row, 'NOT_FOUND', 'Análise não encontrada neste servidor.');
    return JSON.parse(row.payload) as Analysis;
  }
  private canReadAnalysis(a: Analysis, actor: OperationsActor): boolean {
    return actor.moderator || [a.requesterId, a.subjectId].includes(actor.userId)
      || (a.assignedTo === actor.userId && !!actor.analyst);
  }
  private saveAnalysis(a: Analysis): Analysis {
    this.store.db.prepare('UPDATE operations_analyses SET state=?,assigned_to=?,payload=? WHERE guild_id=? AND id=?')
      .run(a.state, a.assignedTo, JSON.stringify(a), a.guildId, a.id);
    return a;
  }
  requestAnalysis(guild: string, matchId: string, actor: OperationsActor, subjectId: string, reason: string, evidenceUrl: string | null = null): Analysis {
    const match = this.bot.viewMatch(guild, matchId, actor);
    requireCondition(match.players.some(p => p.userId === subjectId), 'INVALID_SUBJECT', 'O jogador analisado precisa participar da partida.');
    reason = this.text(reason, 5, 1000, 'Motivo');
    if (evidenceUrl !== null) {
      let valid = false;
      try { const url = new URL(evidenceUrl); valid = url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) && !url.username && !url.password; } catch { /* Validação abaixo. */ }
      requireCondition(valid && evidenceUrl.length <= 2000, 'INVALID_EVIDENCE', 'Use um anexo HTTPS do Discord como evidência.');
    }
    return this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT payload FROM operations_analyses WHERE guild_id=? AND match_id=? AND subject_id=? AND state!='completed'").get(guild, matchId, subjectId) as JsonRow | undefined;
      if (existing) {
        const a = JSON.parse(existing.payload) as Analysis;
        requireCondition(this.canReadAnalysis(a, actor), 'ALREADY_REQUESTED', 'Já existe uma análise em andamento para esse jogador nesta partida.');
        return a;
      }
      const analysis: Analysis = {
        id: randomUUID(), guildId: guild, matchId, requesterId: actor.userId, subjectId, reason, evidenceUrl,
        state: 'open', assignedTo: null, createdAt: this.now(), completedAt: null, outcome: null, decisionReason: null,
      };
      this.store.db.prepare('INSERT INTO operations_analyses(id,guild_id,match_id,requester_id,subject_id,state,assigned_to,payload) VALUES(?,?,?,?,?,?,?,?)')
        .run(analysis.id, guild, matchId, actor.userId, subjectId, analysis.state, null, JSON.stringify(analysis));
      this.event(guild, analysis.id, actor.userId, 'analysis_requested', { matchId, subjectId });
      return analysis;
    });
  }
  analysis(guild: string, id: string, actor: OperationsActor): Analysis {
    const analysis = this.analysisRecord(guild, id);
    requireCondition(this.canReadAnalysis(analysis, actor), 'FORBIDDEN', 'Você não tem acesso a esta análise.');
    return analysis;
  }
  analyses(guild: string, actor: OperationsActor): AnalysisSummary[] {
    this.configured(guild);
    return (this.store.db.prepare('SELECT payload FROM operations_analyses WHERE guild_id=? ORDER BY rowid DESC LIMIT 200').all(guild) as JsonRow[])
      .map(r => JSON.parse(r.payload) as Analysis)
      .filter(a => this.canReadAnalysis(a, actor) || (!!actor.analyst && a.state === 'open'))
      .map(({ id, matchId, state, assignedTo, createdAt }) => ({ id, matchId, state, assignedTo, createdAt }));
  }
  claimAnalysis(guild: string, id: string, actor: OperationsActor): Analysis {
    requireCondition(actor.moderator || actor.analyst, 'FORBIDDEN', 'Somente um analista autorizado ou a moderação pode assumir análises.');
    return this.store.transaction(() => {
      const analysis = this.analysisRecord(guild, id);
      requireCondition(![analysis.requesterId, analysis.subjectId].includes(actor.userId), 'CONFLICT_OF_INTEREST', 'Solicitante e analisado não podem assumir a própria análise.');
      if (analysis.state === 'claimed' && analysis.assignedTo === actor.userId) return analysis;
      requireCondition(analysis.state === 'open', 'INVALID_STATE', 'Esta análise já foi assumida ou encerrada.');
      analysis.state = 'claimed'; analysis.assignedTo = actor.userId;
      this.event(guild, id, actor.userId, 'analysis_claimed');
      return this.saveAnalysis(analysis);
    });
  }
  decideAnalysis(guild: string, id: string, actor: OperationsActor, outcome: AnalysisOutcome, reason: string): Analysis {
    requireCondition(['approved', 'irregularity', 'inconclusive'].includes(outcome), 'INVALID_OUTCOME', 'Conclusão inválida.');
    reason = this.text(reason, 5, 1500, 'Justificativa');
    return this.store.transaction(() => {
      const analysis = this.analysisRecord(guild, id);
      requireCondition(analysis.assignedTo === actor.userId && (actor.moderator || actor.analyst), 'FORBIDDEN', 'Somente o analista atribuído e ainda autorizado pode concluir esta análise.');
      if (analysis.state === 'completed' && analysis.outcome === outcome && analysis.decisionReason === reason) return analysis;
      requireCondition(analysis.state === 'claimed', 'INVALID_STATE', 'Assuma a análise antes de registrar uma conclusão.');
      analysis.state = 'completed'; analysis.outcome = outcome; analysis.decisionReason = reason; analysis.completedAt = this.now();
      this.event(guild, id, actor.userId, 'analysis_completed', { outcome, reason });
      return this.saveAnalysis(analysis);
    });
  }
  profile(guild: string, target: string, viewer: OperationsActor): Profile {
    this.configured(guild);
    const row = this.bot.ranking(guild).find(r => r.userId === target);
    const wins = row?.wins ?? 0; const losses = row?.losses ?? 0;
    const profile: Profile = { userId: target, wins, losses, played: wins + losses, winRate: wins + losses ? Math.round(wins / (wins + losses) * 10000) / 100 : 0 };
    if (viewer.userId === target || viewer.moderator) {
      const reservation = this.bot.reservation(guild, target);
      profile.active = reservation ? { queueId: reservation.queue_id, matchId: reservation.match_id } : null;
      profile.ticketsOpened = Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM operations_tickets WHERE guild_id=? AND owner_id=?').get(guild, target)?.count ?? 0);
    }
    return profile;
  }
}
