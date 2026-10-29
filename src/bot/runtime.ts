import {
  ChannelType, Client, DiscordAPIError, Events, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild,
} from 'discord.js';
import { DomainError, requireCondition, parseMoney, TERMINAL, type Actor, type GuildConfig, type Match, type Platform } from '../domain.js';
import { BotService } from '../service.js';
import type { RuntimeConfig } from '../config.js';
import { reportError } from '../config.js';
import { SimulatedRoomProvider, type RoomProvider } from '../providers.js';
import { HttpRoomProvider } from '../room-api.js';
import { OperationsService } from '../operations.js';
import { PaymentsService } from '../payments.js';
import { handleOperations, syncTicketChannel } from './operations-handler.js';
import { handlePayment } from './payment-handler.js';
import { createHash, randomUUID } from 'node:crypto';
import { DurableOutbox, type JsonValue } from '../outbox.js';
import { PaymentHub } from '../payment-hub.js';
import { handlePix } from './pix-handler.js';
import { matchButtons, matchEmbed, noMentions, queueButtons, queueEmbed } from './presentation.js';

type Interaction = ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>;
const viewPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
function missingResource(error: unknown, code: number): null {
  if (error instanceof DiscordAPIError && error.code === code) return null;
  throw error;
}

export class BotRuntime {
  private readonly provider: RoomProvider | undefined;
  private readonly operations: OperationsService;
  private readonly payments: PaymentsService;
  private readonly outbox: DurableOutbox;
  private readonly paymentHub: PaymentHub;
  private readonly workerId = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly rendered = new Map<string, string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private paymentTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private sweeping = false;

  constructor(private readonly client: Client, private readonly service: BotService, private readonly config: RuntimeConfig) {
    this.operations = new OperationsService(service.store, service);
    this.payments = new PaymentsService(service.store, service);
    this.outbox = new DurableOutbox(service.store);
    this.paymentHub = new PaymentHub(service, this.payments);
    this.provider = config.roomMode === 'simulated' ? new SimulatedRoomProvider()
      : config.roomMode === 'api' && config.roomApi ? new HttpRoomProvider({ ...config.roomApi, getMatch: reference => {
        const match = service.matches().find(m => m.id === reference);
        requireCondition(match, 'NOT_FOUND', 'Partida da solicitação não encontrada.'); return match;
      } }) : undefined;
  }

  start(): void {
    this.client.on(Events.InteractionCreate, interaction => {
      if (this.stopping || !interaction.inCachedGuild() || (!interaction.isChatInputCommand() && !interaction.isButton())) return;
      this.track(this.handle(interaction));
    });
    this.timer = setInterval(() => { this.track(this.sweep()); }, 15_000);
    this.paymentTimer = setInterval(() => { this.track(this.paymentHub.poll()); }, 30_000);
    this.track(this.paymentHub.poll());
    this.track(this.sweep());
  }
  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.catch(error => reportError(error, 'background')).finally(() => this.tasks.delete(task));
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.paymentTimer) clearInterval(this.paymentTimer);
    await Promise.allSettled([...this.tasks]);
  }
  private actor(i: Interaction): Actor {
    const cfg = this.service.config(i.guildId);
    return {
      userId: i.user.id,
      moderator: i.memberPermissions.has(PermissionFlagsBits.ManageGuild) || !!(cfg && i.member.roles.cache.has(cfg.staffRoleId)),
      mediator: !!(cfg && i.member.roles.cache.has(cfg.mediatorRoleId)),
    };
  }
  private teamAccess(actor: Actor): void {
    requireCondition(actor.moderator || actor.mediator, 'FORBIDDEN', 'Este comando é exclusivo da equipe.');
  }
  private async refreshQueue(guild: Guild, id: string): Promise<void> {
    const q = this.service.queue(guild.id, id);
    if (!q.channelId || !q.messageId) return;
    const channel = await guild.channels.fetch(q.channelId, { force: true }).catch(error => missingResource(error, 10003));
    if (channel?.isTextBased() && 'messages' in channel) {
      const message = await channel.messages.fetch({ message: q.messageId, force: true }).catch(error => missingResource(error, 10008));
      const payload = { embeds: [queueEmbed(q, this.service.queuePlayers(guild.id, id))], components: [queueButtons(id)], allowedMentions: noMentions };
      if (message?.author.id === this.client.user!.id) await message.edit(payload);
      else if (!message && channel.type === ChannelType.GuildText) {
        const sent = await channel.send(payload); this.service.setQueuePanel(guild.id, id, channel.id, sent.id);
      }
    }
  }

  private async overwrites(guild: Guild, cfg: GuildConfig, m: Match) {
    let mediatorId: string | null = null;
    if (m.mediatorId) {
      const member = await guild.members.fetch({ user: m.mediatorId, force: true }).catch(error => missingResource(error, 10007));
      if (member && (member.roles.cache.has(cfg.mediatorRoleId) || member.roles.cache.has(cfg.staffRoleId) || member.permissions.has(PermissionFlagsBits.ManageGuild))) mediatorId = member.id;
    }
    const allowedUsers = new Set([this.client.user!.id, ...m.players.map(p => p.userId), ...(mediatorId ? [mediatorId] : [])]);
    return [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: cfg.staffRoleId, allow: viewPermissions },
      ...[...allowedUsers].map(id => ({ id, allow: viewPermissions })),
    ];
  }
  async syncMatch(id: string, guildId: string): Promise<void> {
    const current = this.locks.get(id);
    if (current) {
      await current;
      return this.syncMatch(id, guildId);
    }
    const task = this.updateMatch(id, guildId);
    this.locks.set(id, task);
    try { await task; } finally { this.locks.delete(id); }
  }
  private async updateMatch(id: string, guildId: string): Promise<void> {
    let m = this.service.match(guildId, id);
    const cfg = this.service.config(guildId);
    if (!cfg || (TERMINAL.has(m.state) && !m.channelId)) return;
    const guild = await this.client.guilds.fetch(guildId);
    let channel = m.channelId ? await guild.channels.fetch(m.channelId, { force: true }).catch(error => missingResource(error, 10003)) : null;
    if (channel) requireCondition(channel.type === ChannelType.GuildText && channel.topic === `ff-match:${id}`, 'CHANNEL_MISMATCH', 'O canal da partida foi alterado. Solicite revisão da administração.');
    if (!channel) {
      if (TERMINAL.has(m.state)) return;
      const existing = await guild.channels.fetch();
      channel = existing.find(c => c?.type === ChannelType.GuildText && c.topic === `ff-match:${id}`) ?? null;
      if (!channel) channel = await guild.channels.create({
        name: `partida-${id.slice(0, 8)}`, type: ChannelType.GuildText, parent: cfg.categoryId,
        topic: `ff-match:${id}`, permissionOverwrites: await this.overwrites(guild, cfg, m),
        reason: 'Partida formada pelo bot de Free Fire',
      });
      m = this.service.attachChannel(guildId, id, channel.id, null);
    }
    requireCondition(channel.type === ChannelType.GuildText, 'CHANNEL_TYPE', 'O canal precisa ser um canal de texto.');
    // Antes de publicar dados da sala, restaura o acesso restrito da partida.
    const accessMediator = m.mediatorId;
    await channel.permissionOverwrites.set(await this.overwrites(guild, cfg, m));
    // Releitura após chamadas de rede: confirmações/resultados podem ter mudado.
    m = this.service.match(guildId, id);
    if (m.mediatorId !== accessMediator) await channel.permissionOverwrites.set(await this.overwrites(guild, cfg, m));
    let message = m.messageId ? await channel.messages.fetch({ message: m.messageId, force: true }).catch(error => missingResource(error, 10008)) : null;
    if (!message) {
      // Recupera uma mensagem enviada antes de uma interrupção do processo.
      const recent = await channel.messages.fetch({ limit: 30 });
      message = recent.find(msg => msg.author.id === this.client.user!.id && msg.embeds.some(e => e.footer?.text === `ID: ${id}`)) ?? null;
    }
    const payload = { embeds: [matchEmbed(m)], components: matchButtons(m), allowedMentions: noMentions };
    if (message) {
      requireCondition(message.author.id === this.client.user!.id, 'MESSAGE_AUTHOR', 'Mensagem de partida inválida.');
      if (this.rendered.get(id) !== JSON.stringify([m, cfg])) await message.edit(payload);
    } else message = await channel.send(payload);
    this.service.attachChannel(guildId, id, channel.id, message.id);
    // Guarda o que foi publicado, não um estado mais recente surgido durante o await.
    this.rendered.set(id, JSON.stringify([{ ...m, channelId: channel.id, messageId: message.id }, cfg]));
  }
  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      this.service.expireConfirmations();
      this.operations.expireDuties();
      for (let m of this.service.matches()) {
        if (this.stopping || !this.client.guilds.cache.has(m.guildId)) continue;
        try {
          if (m.state === 'room_pending' && this.provider) m = await this.service.reconcileRoom(m.guildId, m.id, this.provider);
          this.schedule(`match:${m.id}`, 'sync_match', { guildId: m.guildId, id: m.id }, [m, this.service.config(m.guildId)]);
        } catch (error) { reportError(error, 'recover_match'); }
      }
      for (const guild of this.client.guilds.cache.values()) {
        for (const ticket of this.operations.ticketsForReconciliation(guild.id)) {
          try { this.schedule(`ticket:${ticket.id}`, 'sync_ticket', { guildId: guild.id, id: ticket.id }, [ticket, this.service.config(guild.id)]); }
          catch (error) { reportError(error, 'recover_ticket'); }
        }
      }
      for (const queue of this.service.queues()) if (this.client.guilds.cache.has(queue.guildId) && queue.messageId) {
        this.schedule(`queue:${queue.id}`, 'sync_queue', { guildId: queue.guildId, id: queue.id }, [queue, this.service.queuePlayers(queue.guildId, queue.id)]);
      }
      for (let count = 0; count < 25 && !this.stopping; count++) {
        const job = this.outbox.claim(this.workerId, 120_000); if (!job) break;
        try {
          requireCondition(job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload), 'INVALID_JOB', 'Tarefa sem referência válida.');
          const { guildId, id } = job.payload;
          requireCondition(typeof guildId === 'string' && typeof id === 'string' && this.client.guilds.cache.has(guildId), 'INVALID_JOB', 'Servidor da tarefa indisponível.');
          if (job.type === 'sync_match') await this.syncMatch(id, guildId);
          else if (job.type === 'sync_ticket') await syncTicketChannel(await this.client.guilds.fetch(guildId), this.client.user!.id, this.service, this.operations, id);
          else if (job.type === 'sync_queue') await this.refreshQueue(await this.client.guilds.fetch(guildId), id);
          else throw new DomainError('INVALID_JOB', 'Tipo de tarefa desconhecido.');
          this.outbox.complete(this.workerId, job);
        } catch (error) {
          this.outbox.fail(this.workerId, job, error instanceof DomainError ? error.code : 'DELIVERY_FAILED');
          reportError(error, 'outbox_delivery');
        }
      }
    } finally { this.sweeping = false; }
  }
  private schedule(key: string, type: string, reference: Record<string, string>, source: unknown): void {
    const version = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    const prior = this.outbox.get(key);
    const payload = prior?.payload && typeof prior.payload === 'object' && !Array.isArray(prior.payload) ? prior.payload : undefined;
    if (prior && prior.state !== 'done' && payload?.version === version) return;
    this.outbox.enqueue(key, type, { ...reference, version, recheck: Math.floor(Date.now() / 15_000) } satisfies JsonValue);
  }

  private async handle(i: Interaction): Promise<void> {
    try {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const actor = this.actor(i);
      if (i.isButton()) {
        const [group, action, id] = i.customId.split(':');
        requireCondition(id, 'INVALID_BUTTON', 'Botão inválido.');
        if (group === 'q' && action === 'join') {
          const result = this.service.joinQueue(i.guildId, id, actor.userId);
          await i.editReply(result.match ? `Partida formada: \`${result.match.id}\`. O canal privado está sendo preparado; use /partida para consultar.` : result.alreadyJoined ? 'Você já está nesta fila.' : 'Você entrou na fila.');
          await this.refreshQueue(i.guild, id);
          if (result.match) await this.syncMatch(result.match.id, i.guildId);
          return;
        }
        if (group === 'q' && action === 'leave') {
          this.service.leaveQueue(i.guildId, id, actor.userId);
          await i.editReply('Você saiu da fila.'); await this.refreshQueue(i.guild, id); return;
        }
        let m: Match;
        if (group === 'm' && action === 'confirm') m = this.service.confirm(i.guildId, id, actor.userId);
        else if (group === 'm' && action === 'decline') m = this.service.cancel(i.guildId, id, actor, 'Participante desistiu durante a confirmação.');
        else if (group === 'm' && action === 'accept') m = this.service.acceptResult(i.guildId, id, actor.userId);
        else throw new DomainError('INVALID_BUTTON', 'Botão desconhecido.');
        await i.editReply('Ação registrada.'); await this.syncMatch(m.id, m.guildId); return;
      }
      await this.command(i, actor);
    } catch (error) {
      reportError(error, 'interaction');
      const message = error instanceof DomainError ? error.message : 'Não foi possível concluir a atualização. Consulte /fila ou /partida antes de repetir e avise a administração.';
      try {
        if (i.deferred || i.replied) await i.editReply({ content: message, allowedMentions: noMentions });
        else await i.reply({ content: message, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
      } catch (replyError) { reportError(replyError, 'interaction_reply'); }
    }
  }

  private async command(i: ChatInputCommandInteraction<'cached'>, actor: Actor): Promise<void> {
    if (await handlePix(i, actor, this.paymentHub)) return;
    if (i.commandName === 'financeiro' && ['premiar', 'taxa'].includes(i.options.getSubcommand())) {
      this.service.authorizeMediator(i.guildId, i.options.getString('partida', true), actor);
      this.paymentHub.assertNoFinancialReview(i.guildId, i.options.getString('partida', true));
    }
    if (await handleOperations(i, actor, this.service, this.operations)) return;
    if (await handlePayment(i, actor, this.service, this.payments)) return;
    const o = i.options;
    const str = (name: string) => o.getString(name, true);
    const part = () => str('partida');
    let changed: Match | undefined;
    switch (i.commandName) {
      case 'configurar': {
        const staff = o.getRole('staff', true); const mediator = o.getRole('mediador', true);
        requireCondition(staff.id !== i.guildId && mediator.id !== i.guildId, 'INVALID_ROLE', 'Escolha cargos específicos; não use @everyone.');
        const analystRoleId = o.getRole('analista')?.id ?? this.service.config(i.guildId)?.analystRoleId;
        requireCondition(analystRoleId !== i.guildId, 'INVALID_ROLE', 'Não use @everyone como cargo de analista.');
        this.service.configure({ guildId: i.guildId, categoryId: o.getChannel('categoria', true).id, staffRoleId: staff.id, mediatorRoleId: mediator.id, analystRoleId }, actor);
        await i.editReply('Configuração salva. Publique uma fila com /painel-fila.'); return;
      }
      case 'painel-fila': {
        const q = this.service.createQueue(i.guildId, actor, o.getInteger('time', true), str('plataforma') as Platform, str('regras'), parseMoney(o.getString('valor') ?? '0'));
        const channel = i.channel;
        requireCondition(channel?.type === ChannelType.GuildText, 'CHANNEL_TYPE', 'Publique a fila em um canal de texto do servidor.');
        const message = await channel.send({ embeds: [queueEmbed(q, this.service.queuePlayers(i.guildId, q.id))], components: [queueButtons(q.id)], allowedMentions: noMentions });
        this.service.setQueuePanel(i.guildId, q.id, channel.id, message.id);
        await i.editReply('Painel publicado. O valor é informativo; o bot não movimenta dinheiro.'); return;
      }
      case 'fila': {
        const r = this.service.reservation(i.guildId, actor.userId);
        await i.editReply(r?.match_id ? `Sua partida: \`${r.match_id}\`. Use /partida.` : r?.queue_id ? `Você está na fila \`${r.queue_id}\`.` : 'Você não está em fila ou partida ativa.'); return;
      }
      case 'partida': {
        const id = o.getString('id') || this.service.reservation(i.guildId, actor.userId)?.match_id;
        requireCondition(id, 'NOT_FOUND', 'Informe o ID ou entre em uma partida.');
        const m = this.service.viewMatch(i.guildId, id, actor);
        await i.editReply({ embeds: [matchEmbed(m)], allowedMentions: noMentions }); return;
      }
      case 'mediador': {
        this.teamAccess(actor);
        if (o.getSubcommand() === 'pendentes') {
          const pending = this.service.matches(i.guildId).filter(m => m.state === 'awaiting_mediator').slice(-20);
          await i.editReply(pending.map(m => `\`${m.id}\` • ${m.teamSize}x${m.teamSize} • ${m.platform}`).join('\n') || 'Nenhuma partida aguardando mediador.'); return;
        }
        changed = this.service.claim(i.guildId, part(), actor); break;
      }
      case 'sala': {
        this.service.authorizeMediator(i.guildId, part(), actor);
        this.paymentHub.assertNoFinancialReview(i.guildId, part());
        if (o.getSubcommand() === 'informar') {
          this.payments.assertReadyForRoom(i.guildId, part());
          changed = this.service.informRoom(i.guildId, part(), actor, str('id'), str('senha'));
        } else if (o.getSubcommand() === 'iniciar') {
          this.payments.assertFundedForPlay(i.guildId, part());
          changed = this.service.startMatch(i.guildId, part(), actor);
        } else if (o.getSubcommand() === 'reconciliar') {
          const m = this.service.match(i.guildId, part());
          requireCondition(actor.moderator || (actor.mediator && m.mediatorId === actor.userId), 'FORBIDDEN', 'Somente o mediador atribuído ou a moderação pode consultar o provedor.');
          requireCondition(this.provider, 'MANUAL_MODE', 'O modo manual não possui API para consulta.');
          changed = await this.service.reconcileRoom(i.guildId, part(), this.provider);
        }
        else {
          requireCondition(this.provider, 'MANUAL_MODE', 'Modo manual: crie a sala no jogo e use /sala informar, ou configure uma API compatível.');
          this.payments.assertReadyForRoom(i.guildId, part());
          changed = await this.service.createRoom(i.guildId, part(), actor, this.provider);
        }
        break;
      }
      case 'resultado': {
        const sub = o.getSubcommand();
        if (sub === 'registrar') changed = this.service.proposeResult(i.guildId, part(), actor, o.getInteger('vencedor', true), str('placar'));
        else if (sub === 'contestar') changed = this.service.dispute(i.guildId, part(), actor.userId, str('motivo'));
        else changed = this.service.resolve(i.guildId, part(), actor, o.getInteger('vencedor', true), str('motivo'));
        break;
      }
      case 'cancelar': changed = this.service.cancel(i.guildId, part(), actor, str('motivo')); break;
      case 'ranking': {
        const rows = this.service.ranking(i.guildId).slice(0, 20);
        await i.editReply({ content: rows.map((r, index) => `${index + 1}. <@${r.userId}> • ${r.wins} V / ${r.losses} D`).join('\n') || 'Nenhuma partida encerrada neste servidor.', allowedMentions: noMentions }); return;
      }
      case 'blacklist': {
        const user = o.getUser('jogador', true).id;
        const reason = str('acao') === 'remove' ? null : o.getString('motivo') ?? '';
        const queue = this.service.reservation(i.guildId, user)?.queue_id;
        this.service.blacklist(i.guildId, actor, user, reason);
        await i.editReply('Bloqueio atualizado e registrado.');
        if (queue) await this.refreshQueue(i.guild, queue); return;
      }
      case 'status': {
        this.teamAccess(actor);
        const active = this.service.matches(i.guildId).filter(m => !TERMINAL.has(m.state));
        const failedJobs = this.service.store.db.prepare("SELECT COUNT(*) AS total FROM outbox_jobs WHERE state='dead' AND json_extract(payload,'$.guildId')=?").get(i.guildId)?.total ?? 0;
        await i.editReply(`Modo de salas: **${this.config.roomMode}**\nPartidas ativas: ${active.length}\nCriações pendentes: ${active.filter(m => m.state === 'room_pending').length}\nTarefas que exigem revisão: ${failedJobs}\nBanco: SQLite persistente\nFinanceiro: conferência manual auditável\nPIX automático: depende de provedor aprovado e configuração.`); return;
      }
      case 'tarefas': {
        requireCondition(actor.moderator, 'FORBIDDEN', 'Somente a moderação pode revisar tarefas.');
        if (o.getSubcommand() === 'repetir') {
          const key = str('chave'); const job = this.outbox.get(key);
          requireCondition(job && job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) && job.payload.guildId === i.guildId, 'NOT_FOUND', 'Tarefa não encontrada neste servidor.');
          this.outbox.retryDead(key); await i.editReply('Tarefa liberada para nova tentativa.');
        } else {
          const rows = this.service.store.db.prepare("SELECT job_key,state,last_error FROM outbox_jobs WHERE json_extract(payload,'$.guildId')=? AND state!='done' LIMIT 15").all(i.guildId) as { job_key: string; state: string; last_error: string | null }[];
          await i.editReply(rows.map(r => `\`${r.job_key}\` • ${r.state} • ${r.last_error ?? 'aguardando'}`).join('\n') || 'Nenhuma tarefa pendente.');
        }
        return;
      }
      default: throw new DomainError('UNKNOWN_COMMAND', 'Comando não reconhecido. Atualize os comandos do bot.');
    }
    if (changed) {
      await i.editReply(`Ação registrada na partida \`${changed.id}\`.`);
      await this.syncMatch(changed.id, changed.guildId);
    }
  }
}
