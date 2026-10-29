import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { Store } from './database.js';
import {
  DomainError, requireCondition, TERMINAL,
  type Actor, type GuildConfig, type Match, type Platform, type Queue, type Room,
} from './domain.js';
import { RoomNotCreatedError, validateRoom, type RoomProvider } from './providers.js';

type QueueRow = { id: string; guild_id: string; team_size: number; platform: Platform; rules: string; stake_cents: number; channel_id: string | null; message_id: string | null };
type Payload = { payload: string };
const fromQueue = (r: QueueRow): Queue => ({ id: r.id, guildId: r.guild_id, teamSize: r.team_size, platform: r.platform, rules: r.rules, stakeCents: r.stake_cents, channelId: r.channel_id, messageId: r.message_id });

export class BotService {
  constructor(readonly store: Store, private readonly timeoutMs = 180_000, private readonly now = Date.now) {}
  private audit(guild: string, subject: string, actor: string, action: string, details: Record<string, unknown> = {}): void {
    this.store.db.prepare('INSERT INTO audit(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)')
      .run(guild, subject, actor, action, this.now(), JSON.stringify(details));
  }
  private save(m: Match): Match {
    this.store.db.prepare('UPDATE matches SET state=?,payload=? WHERE id=? AND guild_id=?').run(m.state, JSON.stringify(m), m.id, m.guildId);
    return m;
  }
  private release(m: Match): void {
    this.store.db.prepare('DELETE FROM reservations WHERE guild_id=? AND match_id=?').run(m.guildId, m.id);
  }
  private checkMediator(m: Match, actor: Actor): void {
    requireCondition(actor.moderator || (actor.mediator && m.mediatorId === actor.userId), 'FORBIDDEN', 'Ação permitida apenas ao mediador atribuído ou à moderação.');
  }
  private requireMatchState(m: Match, states: Match['state'][]): void {
    requireCondition(states.includes(m.state), 'INVALID_STATE', `Esta ação não está disponível no estado ${m.state}.`);
  }

  configure(config: GuildConfig, actor: Actor): void {
    requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a administração pode configurar o bot.');
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO guilds(guild_id,payload) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET payload=excluded.payload').run(config.guildId, JSON.stringify(config));
      this.audit(config.guildId, config.guildId, actor.userId, 'configured');
    });
  }
  config(guildId: string): GuildConfig | undefined {
    const row = this.store.db.prepare('SELECT payload FROM guilds WHERE guild_id=?').get(guildId) as Payload | undefined;
    return row ? JSON.parse(row.payload) as GuildConfig : undefined;
  }

  createQueue(guild: string, actor: Actor, teamSize: number, platform: Platform, rules: string, stakeCents = 0): Queue {
    requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a administração pode publicar filas.');
    requireCondition(this.config(guild), 'NOT_CONFIGURED', 'Use /configurar antes de publicar uma fila.');
    requireCondition(Number.isInteger(teamSize) && teamSize >= 1 && teamSize <= 4, 'INVALID_MODE', 'Escolha de 1x1 a 4x4.');
    requireCondition(['mobile', 'emulador', 'misto'].includes(platform), 'INVALID_PLATFORM', 'Plataforma inválida.');
    requireCondition(rules.trim().length >= 3 && rules.length <= 200, 'INVALID_RULES', 'As regras precisam ter de 3 a 200 caracteres.');
    requireCondition(Number.isSafeInteger(stakeCents) && stakeCents >= 0, 'INVALID_MONEY', 'Valor em centavos inválido.');
    const params: SQLInputValue[] = [guild, teamSize, platform, rules.trim(), stakeCents];
    return this.store.transaction(() => {
      this.store.db.prepare('INSERT OR IGNORE INTO queues(id,guild_id,team_size,platform,rules,stake_cents) VALUES(?,?,?,?,?,?)').run(randomUUID(), ...params);
      const row = this.store.db.prepare('SELECT * FROM queues WHERE guild_id=? AND team_size=? AND platform=? AND rules=? AND stake_cents=?').get(...params) as QueueRow;
      return fromQueue(row);
    });
  }
  queue(guild: string, id: string): Queue {
    const row = this.store.db.prepare('SELECT * FROM queues WHERE id=? AND guild_id=?').get(id, guild) as QueueRow | undefined;
    requireCondition(row, 'NOT_FOUND', 'Fila não encontrada neste servidor.');
    return fromQueue(row);
  }
  queues(): Queue[] {
    return (this.store.db.prepare('SELECT * FROM queues').all() as QueueRow[]).map(fromQueue);
  }
  setQueuePanel(guild: string, id: string, channel: string, message: string): void {
    this.queue(guild, id);
    this.store.db.prepare('UPDATE queues SET channel_id=?,message_id=? WHERE id=? AND guild_id=?').run(channel, message, id, guild);
  }
  queuePlayers(guild: string, id: string): string[] {
    this.queue(guild, id);
    return (this.store.db.prepare('SELECT user_id FROM reservations WHERE guild_id=? AND queue_id=? ORDER BY id').all(guild, id) as { user_id: string }[]).map(r => r.user_id);
  }
  reservation(guild: string, user: string): { queue_id: string | null; match_id: string | null } | undefined {
    return this.store.db.prepare('SELECT queue_id,match_id FROM reservations WHERE guild_id=? AND user_id=?').get(guild, user) as { queue_id: string | null; match_id: string | null } | undefined;
  }
  joinQueue(guild: string, id: string, user: string): { queue: Queue; match?: Match; alreadyJoined: boolean } {
    this.expireConfirmations();
    return this.store.transaction(() => {
      const q = this.queue(guild, id);
      requireCondition(!this.store.db.prepare('SELECT 1 FROM blacklist WHERE guild_id=? AND user_id=?').get(guild, user), 'BLACKLISTED', 'Você está bloqueado neste servidor. Consulte a moderação.');
      const active = this.reservation(guild, user);
      if (active?.queue_id === id) return { queue: q, alreadyJoined: true };
      requireCondition(!active, 'ALREADY_ACTIVE', 'Você já está em uma fila ou partida neste servidor.');
      this.store.db.prepare('INSERT INTO reservations(guild_id,user_id,queue_id) VALUES(?,?,?)').run(guild, user, id);
      this.audit(guild, id, user, 'queue_joined');
      const players = this.queuePlayers(guild, id).slice(0, q.teamSize * 2);
      if (players.length < q.teamSize * 2) return { queue: q, alreadyJoined: false };
      const match: Match = {
        id: randomUUID(), guildId: guild, queueId: id, teamSize: q.teamSize, platform: q.platform,
        rules: q.rules, stakeCents: q.stakeCents, state: 'confirming',
        players: players.map((userId, i) => ({ userId, team: i < q.teamSize ? 1 : 2, confirmed: false })),
        createdAt: this.now(), expiresAt: this.now() + this.timeoutMs, mediatorId: null,
        channelId: null, messageId: null, room: null, roomRequestProvider: null, result: null, reason: null,
      };
      this.store.db.prepare('INSERT INTO matches(id,guild_id,state,payload) VALUES(?,?,?,?)').run(match.id, guild, match.state, JSON.stringify(match));
      const reserve = this.store.db.prepare('UPDATE reservations SET queue_id=NULL,match_id=? WHERE guild_id=? AND user_id=?');
      for (const player of players) reserve.run(match.id, guild, player);
      this.audit(guild, match.id, 'system', 'match_formed');
      return { queue: q, match, alreadyJoined: false };
    });
  }
  leaveQueue(guild: string, id: string, user: string): void {
    this.queue(guild, id);
    this.store.transaction(() => {
      requireCondition(this.reservation(guild, user)?.queue_id === id, 'NOT_QUEUED', 'Você não está nesta fila; consulte /partida se ela já foi formada.');
      this.store.db.prepare('DELETE FROM reservations WHERE guild_id=? AND queue_id=? AND user_id=?').run(guild, id, user);
      this.audit(guild, id, user, 'queue_left');
    });
  }

  match(guild: string, id: string): Match {
    const row = this.store.db.prepare('SELECT payload FROM matches WHERE guild_id=? AND id=?').get(guild, id) as Payload | undefined;
    requireCondition(row, 'NOT_FOUND', 'Partida não encontrada neste servidor.');
    return JSON.parse(row.payload) as Match;
  }
  viewMatch(guild: string, id: string, actor: Actor): Match {
    const m = this.match(guild, id);
    requireCondition(actor.moderator || (actor.mediator && m.mediatorId === actor.userId) || m.players.some(p => p.userId === actor.userId), 'FORBIDDEN', 'Você não tem acesso a esta partida.');
    return m;
  }
  authorizeMediator(guild: string, id: string, actor: Actor): Match {
    const match = this.match(guild, id); this.checkMediator(match, actor); return match;
  }
  matches(guild?: string): Match[] {
    const rows = guild
      ? this.store.db.prepare('SELECT payload FROM matches WHERE guild_id=?').all(guild)
      : this.store.db.prepare('SELECT payload FROM matches').all();
    return (rows as Payload[]).map(r => JSON.parse(r.payload) as Match);
  }
  attachChannel(guild: string, id: string, channelId: string, messageId: string | null): Match {
    return this.store.transaction(() => {
      const m = this.match(guild, id); m.channelId = channelId; m.messageId = messageId;
      return this.save(m);
    });
  }
  confirm(guild: string, id: string, user: string): Match {
    this.expireConfirmations();
    return this.store.transaction(() => {
      const m = this.match(guild, id);
      this.requireMatchState(m, ['confirming', 'awaiting_mediator']);
      const player = m.players.find(p => p.userId === user);
      requireCondition(player, 'FORBIDDEN', 'Você não participa desta partida.');
      player.confirmed = true;
      if (m.players.every(p => p.confirmed)) m.state = 'awaiting_mediator';
      this.audit(guild, id, user, 'participation_confirmed');
      return this.save(m);
    });
  }
  claim(guild: string, id: string, actor: Actor): Match {
    requireCondition(actor.moderator || actor.mediator, 'FORBIDDEN', 'É necessário o cargo de mediador.');
    return this.store.transaction(() => {
      const m = this.match(guild, id);
      if (m.mediatorId === actor.userId && m.state === 'ready') return m;
      this.requireMatchState(m, ['awaiting_mediator']);
      m.mediatorId = actor.userId; m.state = 'ready';
      this.audit(guild, id, actor.userId, 'mediator_assigned');
      return this.save(m);
    });
  }
  private completeRoom(guild: string, id: string, room: Room): Match {
    validateRoom(room);
    return this.store.transaction(() => {
      const m = this.match(guild, id);
      this.requireMatchState(m, ['room_pending']);
      m.room = room; m.state = 'room_created';
      this.audit(guild, id, 'system', 'room_created');
      return this.save(m);
    });
  }
  async createRoom(guild: string, id: string, actor: Actor, provider: RoomProvider): Promise<Match> {
    const existing = this.store.transaction(() => {
      const m = this.match(guild, id); this.checkMediator(m, actor);
      if (m.state === 'room_created') return m;
      this.requireMatchState(m, ['ready']);
      m.state = 'room_pending'; m.roomRequestProvider = provider.kind;
      m.roomRequestIdentity = provider.identity ?? provider.kind; this.save(m);
      this.audit(guild, id, actor.userId, 'room_requested');
      return undefined;
    });
    if (existing) return existing;
    try {
      const room = await provider.createRoom(id);
      return this.completeRoom(guild, id, { ...room, source: provider.kind });
    } catch (error) {
      if (error instanceof RoomNotCreatedError) {
        this.store.transaction(() => {
          const m = this.match(guild, id);
          if (m.state === 'room_pending') { m.state = 'ready'; this.save(m); }
        });
        throw error;
      }
      throw new DomainError('ROOM_UNCERTAIN', 'Resposta da sala incerta. A solicitação ficou pendente; não repita a criação.');
    }
  }
  async reconcileRoom(guild: string, id: string, provider: RoomProvider): Promise<Match> {
    const m = this.match(guild, id);
    if (m.state !== 'room_pending') return m;
    requireCondition(m.roomRequestProvider === provider.kind, 'PROVIDER_MISMATCH', 'A solicitação pendente pertence a outro provedor. Não altere sua origem durante a recuperação.');
    requireCondition((m.roomRequestIdentity ?? m.roomRequestProvider) === (provider.identity ?? provider.kind), 'PROVIDER_MISMATCH', 'O endereço ou contrato da API mudou. Recupere a configuração original para consultar a solicitação pendente.');
    const found = await provider.findRoom(id);
    if (!found || this.match(guild, id).state !== 'room_pending') return this.match(guild, id);
    return this.completeRoom(guild, id, { ...found, source: provider.kind });
  }
  informRoom(guild: string, id: string, actor: Actor, roomId: string, password: string): Match {
    const room: Room = { id: roomId, password, source: 'manual' }; validateRoom(room);
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.checkMediator(m, actor); this.requireMatchState(m, ['ready']);
      m.room = room; m.state = 'room_created';
      this.audit(guild, id, actor.userId, 'manual_room_informed');
      return this.save(m);
    });
  }
  startMatch(guild: string, id: string, actor: Actor): Match {
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.checkMediator(m, actor); this.requireMatchState(m, ['room_created']);
      m.state = 'playing'; this.audit(guild, id, actor.userId, 'game_started_manually'); return this.save(m);
    });
  }
  proposeResult(guild: string, id: string, actor: Actor, winner: number, score: string): Match {
    requireCondition(winner === 1 || winner === 2, 'INVALID_WINNER', 'Time vencedor inválido.');
    requireCondition(/^\d{1,3}\s*[-x:]\s*\d{1,3}$/.test(score), 'INVALID_SCORE', 'Use um placar como 7x3.');
    const [a, b] = score.split(/\s*[-x:]\s*/).map(Number) as [number, number];
    requireCondition(a !== b && (winner === 1 ? a > b : b > a), 'INVALID_SCORE', 'O placar (time 1 x time 2) precisa corresponder ao vencedor.');
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.checkMediator(m, actor); this.requireMatchState(m, ['playing']);
      m.result = { winner, score, acceptedBy: [] }; m.state = 'result_pending';
      this.audit(guild, id, actor.userId, 'result_proposed', { winner, score }); return this.save(m);
    });
  }
  acceptResult(guild: string, id: string, user: string): Match {
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.requireMatchState(m, ['result_pending', 'finished']);
      const representatives = [m.players.find(p => p.team === 1)!.userId, m.players.find(p => p.team === 2)!.userId];
      requireCondition(representatives.includes(user), 'FORBIDDEN', 'Somente o primeiro jogador de cada time pode confirmar o resultado.');
      requireCondition(m.result, 'INVALID_STATE', 'Resultado não registrado.');
      if (m.state === 'finished') return m;
      if (!m.result.acceptedBy.includes(user)) m.result.acceptedBy.push(user);
      if (representatives.every(p => m.result!.acceptedBy.includes(p))) { m.state = 'finished'; this.release(m); }
      this.audit(guild, id, user, 'result_accepted'); return this.save(m);
    });
  }
  dispute(guild: string, id: string, user: string, reason: string): Match {
    requireCondition(reason.trim().length >= 3 && reason.length <= 300, 'INVALID_REASON', 'Informe um motivo de 3 a 300 caracteres.');
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.requireMatchState(m, ['result_pending']);
      requireCondition(m.players.some(p => p.userId === user), 'FORBIDDEN', 'Você não participa desta partida.');
      m.state = 'disputed'; m.reason = reason;
      this.audit(guild, id, user, 'result_disputed', { reason }); return this.save(m);
    });
  }
  resolve(guild: string, id: string, actor: Actor, winner: number, reason: string): Match {
    requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a moderação pode resolver disputas.');
    requireCondition(winner === 1 || winner === 2, 'INVALID_WINNER', 'Time vencedor inválido.');
    requireCondition(reason.trim().length >= 3 && reason.length <= 300, 'INVALID_REASON', 'Informe um motivo de 3 a 300 caracteres.');
    return this.store.transaction(() => {
      const m = this.match(guild, id); this.requireMatchState(m, ['disputed']);
      requireCondition(m.result, 'INVALID_STATE', 'Resultado ausente.');
      m.result.decision = { winner, reason }; m.state = 'finished';
      this.release(m); this.audit(guild, id, actor.userId, 'dispute_resolved', { winner, reason }); return this.save(m);
    });
  }
  cancel(guild: string, id: string, actor: Actor, reason: string): Match {
    requireCondition(reason.trim().length >= 3 && reason.length <= 300, 'INVALID_REASON', 'Informe um motivo de 3 a 300 caracteres.');
    return this.store.transaction(() => {
      const m = this.match(guild, id);
      requireCondition(!TERMINAL.has(m.state) && m.state !== 'room_pending', 'INVALID_STATE', 'A partida está encerrada ou tem uma criação de sala incerta.');
      const participant = m.players.some(p => p.userId === actor.userId);
      if (!(participant && m.state === 'confirming')) this.checkMediator(m, actor);
      m.state = 'cancelled'; m.reason = reason; this.release(m);
      this.audit(guild, id, actor.userId, 'match_cancelled', { reason }); return this.save(m);
    });
  }
  expireConfirmations(): Match[] {
    return this.store.transaction(() => {
      const expired: Match[] = [];
      for (const m of this.matches()) if (m.state === 'confirming' && m.expiresAt <= this.now()) {
        m.state = 'expired'; m.reason = 'Prazo de confirmação encerrado.'; this.release(m);
        this.save(m); this.audit(m.guildId, m.id, 'system', 'match_expired'); expired.push(m);
      }
      return expired;
    });
  }
  blacklist(guild: string, actor: Actor, user: string, reason: string | null): void {
    requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a moderação pode alterar bloqueios.');
    requireCondition(reason === null || (reason.trim().length >= 3 && reason.length <= 300), 'INVALID_REASON', 'Informe um motivo de 3 a 300 caracteres.');
    this.store.transaction(() => {
      if (reason === null) this.store.db.prepare('DELETE FROM blacklist WHERE guild_id=? AND user_id=?').run(guild, user);
      else {
        requireCondition(!this.reservation(guild, user)?.match_id, 'ACTIVE_MATCH', 'Encerre ou cancele a partida ativa antes de bloquear este jogador.');
        this.store.db.prepare('INSERT INTO blacklist(guild_id,user_id,reason) VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET reason=excluded.reason').run(guild, user, reason);
        this.store.db.prepare('DELETE FROM reservations WHERE guild_id=? AND user_id=? AND match_id IS NULL').run(guild, user);
      }
      this.audit(guild, user, actor.userId, reason === null ? 'unblocked' : 'blocked', { reason });
    });
  }
  ranking(guild: string): { userId: string; wins: number; losses: number }[] {
    const rows = new Map<string, { userId: string; wins: number; losses: number }>();
    for (const m of this.matches(guild)) if (m.state === 'finished' && m.result) for (const p of m.players) {
      const row = rows.get(p.userId) ?? { userId: p.userId, wins: 0, losses: 0 };
      if (p.team === (m.result.decision?.winner ?? m.result.winner)) row.wins++; else row.losses++;
      rows.set(p.userId, row);
    }
    return [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.userId.localeCompare(b.userId));
  }
}
