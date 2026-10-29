import {
  ChannelType, DiscordAPIError, EmbedBuilder, PermissionFlagsBits,
  type ChatInputCommandInteraction, type Guild,
} from 'discord.js';
import { requireCondition, type Actor } from '../domain.js';
import type { BotService } from '../service.js';
import {
  type Analysis, type AnalysisOutcome, type DutyKind, type OperationsActor,
  type OperationsService, type Ticket,
} from '../operations.js';
import { noMentions } from './presentation.js';

const ticketLocks = new Map<string, Promise<string | null>>();
const ticketRendered = new Map<string, string>();
const viewOnly = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const chat = [...viewOnly, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
function missing(error: unknown, code: number): null {
  if (error instanceof DiscordAPIError && error.code === code) return null;
  throw error;
}
function ticketEmbed(t: Ticket): EmbedBuilder {
  const states = { open: 'Aguardando atendimento', claimed: 'Em atendimento', closed: 'Encerrado' };
  const embed = new EmbedBuilder().setColor(t.state === 'closed' ? 0x747f8d : 0x5865f2)
    .setTitle(`Ticket • ${t.title}`).setDescription(t.description)
    .addFields(
      { name: 'Status', value: states[t.state], inline: true },
      { name: 'Solicitante', value: `<@${t.ownerId}>`, inline: true },
      { name: 'Atendente', value: t.assignedTo ? `<@${t.assignedTo}>` : 'Aguardando atribuição.' },
    ).setFooter({ text: `TICKET:${t.id}` });
  if (t.closeReason) embed.addFields({ name: 'Motivo do encerramento', value: t.closeReason });
  return embed;
}
function analysisEmbed(a: Analysis): EmbedBuilder {
  const labels = { open: 'Aguardando analista', claimed: 'Em análise', completed: 'Concluída' };
  const outcomes = { approved: 'Sem irregularidade constatada', irregularity: 'Irregularidade constatada', inconclusive: 'Inconclusiva' };
  const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`Análise ${a.id.slice(0, 8)} • ${labels[a.state]}`)
    .setDescription(a.reason).addFields(
      { name: 'Partida', value: a.matchId },
      { name: 'Solicitante', value: `<@${a.requesterId}>`, inline: true },
      { name: 'Analisado', value: `<@${a.subjectId}>`, inline: true },
      { name: 'Analista atribuído', value: a.assignedTo ? `<@${a.assignedTo}>` : 'Aguardando atribuição.' },
    ).setFooter({ text: `ID: ${a.id} • Avaliação humana; não é detecção automática` });
  if (a.evidenceUrl) embed.addFields({ name: 'Evidência fornecida', value: `[Abrir anexo do Discord](${a.evidenceUrl})` });
  if (a.outcome) embed.addFields({ name: 'Conclusão', value: outcomes[a.outcome] });
  if (a.decisionReason) embed.addFields({ name: 'Justificativa', value: a.decisionReason });
  return embed;
}

/** Reconcilia somente o canal privado do ticket; não cria mensagens públicas. */
export async function syncTicketChannel(guild: Guild, botId: string, service: BotService, operations: OperationsService, id: string): Promise<string | null> {
  const key = `${guild.id}:${id}`;
  const pending = ticketLocks.get(key);
  if (pending) { await pending; return syncTicketChannel(guild, botId, service, operations, id); }
  const work = updateTicketChannel(guild, botId, service, operations, id);
  ticketLocks.set(key, work);
  try { return await work; } finally { ticketLocks.delete(key); }
}
async function updateTicketChannel(guild: Guild, botId: string, service: BotService, operations: OperationsService, id: string): Promise<string | null> {
  let t = operations.ticketsForReconciliation(guild.id).find(ticket => ticket.id === id);
  requireCondition(t, 'NOT_FOUND', 'Ticket não encontrado neste servidor.');
  const cfg = service.config(guild.id);
  requireCondition(cfg, 'NOT_CONFIGURED', 'Configure o servidor antes de criar o canal do ticket.');
  let channel = t.channelId ? await guild.channels.fetch(t.channelId, { force: true }).catch(error => missing(error, 10003)) : null;
  if (channel) requireCondition(channel.type === ChannelType.GuildText && channel.topic === `ops-ticket:${id}`, 'CHANNEL_MISMATCH', 'O canal de atendimento foi alterado. Solicite revisão da administração.');
  const assigned = t.assignedTo && t.assignedTo !== t.ownerId
    ? await guild.members.fetch({ user: t.assignedTo, force: true }).catch(error => missing(error, 10007))
    : null;
  const validAssignee = assigned && (assigned.permissions.has(PermissionFlagsBits.ManageGuild)
    || assigned.roles.cache.has(cfg.staffRoleId) || assigned.roles.cache.has(cfg.mediatorRoleId))
    ? assigned.id : null;
  const overwrites = (ticket: Ticket) => [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: cfg.staffRoleId, allow: ticket.state === 'closed' ? viewOnly : chat, ...(ticket.state === 'closed' ? { deny: [PermissionFlagsBits.SendMessages] } : {}) },
    { id: botId, allow: chat },
    ...[...new Set([ticket.ownerId, ...(ticket.assignedTo === validAssignee ? [validAssignee!] : [])])].map(userId => ({ id: userId, allow: ticket.state === 'closed' ? viewOnly : chat, ...(ticket.state === 'closed' ? { deny: [PermissionFlagsBits.SendMessages] } : {}) })),
  ];
  if (!channel) {
    const channels = await guild.channels.fetch();
    channel = channels.find(c => c?.type === ChannelType.GuildText && c.topic === `ops-ticket:${id}`) ?? null;
    if (!channel && t.state === 'closed') return null;
    if (!channel) channel = await guild.channels.create({
      type: ChannelType.GuildText, name: `ticket-${id.slice(0, 8)}`, parent: cfg.categoryId,
      topic: `ops-ticket:${id}`, permissionOverwrites: overwrites(t), reason: 'Atendimento privado solicitado no bot',
    });
    t = operations.attachTicketChannel(guild.id, id, channel.id, null);
  }
  requireCondition(channel.type === ChannelType.GuildText, 'CHANNEL_TYPE', 'O ticket precisa de um canal de texto.');
  const accessState = t.state; const accessAssignee = t.assignedTo;
  await channel.permissionOverwrites.set(overwrites(t));
  t = operations.ticketsForReconciliation(guild.id).find(ticket => ticket.id === id)!;
  if (accessState !== t.state || accessAssignee !== t.assignedTo) await channel.permissionOverwrites.set(overwrites(t));
  let message = t.messageId ? await channel.messages.fetch({ message: t.messageId, force: true }).catch(error => missing(error, 10008)) : null;
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 30 });
    message = recent.find(m => m.author.id === botId && m.embeds.some(e => e.footer?.text === `TICKET:${id}`)) ?? null;
  }
  const payload = { embeds: [ticketEmbed(t)], allowedMentions: noMentions };
  if (message) {
    requireCondition(message.author.id === botId, 'MESSAGE_AUTHOR', 'Mensagem de atendimento inválida.');
    if (ticketRendered.get(id) !== JSON.stringify([t, cfg])) await message.edit(payload);
  } else message = await channel.send(payload);
  operations.attachTicketChannel(guild.id, id, channel.id, message.id);
  ticketRendered.set(id, JSON.stringify([{ ...t, channelId: channel.id, messageId: message.id }, cfg]));
  return channel.id;
}

export async function handleOperations(i: ChatInputCommandInteraction<'cached'>, actor: Actor, service: BotService, operations: OperationsService): Promise<boolean> {
  if (!['ticket', 'plantao', 'analise', 'perfil'].includes(i.commandName)) return false;
  const cfg = service.config(i.guildId);
  const analyst = !!(cfg?.analystRoleId && i.member.roles.cache.has(cfg.analystRoleId));
  const opActor: OperationsActor = { ...actor, analyst };
  const o = i.options;
  const str = (name: string) => o.getString(name, true);
  if (i.commandName === 'ticket') {
    const action = o.getSubcommand();
    if (action === 'listar') {
      const tickets = operations.tickets(i.guildId, opActor).slice(0, 15);
      await i.editReply({ content: tickets.map(t => `\`${t.id}\` • ${t.state} • ${t.title}`).join('\n') || 'Nenhum atendimento disponível.', allowedMentions: noMentions });
      return true;
    }
    let ticket: Ticket;
    if (action === 'abrir') ticket = operations.openTicket(i.guildId, opActor, str('titulo'), str('descricao'));
    else if (action === 'assumir') ticket = operations.claimTicket(i.guildId, str('id'), opActor);
    else if (action === 'fechar') ticket = operations.closeTicket(i.guildId, str('id'), opActor, str('motivo'));
    else ticket = operations.ticket(i.guildId, str('id'), opActor);
    // O registro já está persistido; em caso de falha na rede, /ticket ver recupera a entrega.
    await i.editReply({ content: `Atendimento registrado: \`${ticket.id}\`. Preparando o canal privado.`, allowedMentions: noMentions });
    const channel = await syncTicketChannel(i.guild, i.client.user.id, service, operations, ticket.id);
    ticket = operations.ticket(i.guildId, ticket.id, opActor);
    await i.editReply({ content: channel ? `Canal privado: <#${channel}>` : 'Ticket encerrado. Histórico preservado.', embeds: [ticketEmbed(ticket)], allowedMentions: noMentions });
    return true;
  }
  if (i.commandName === 'plantao') {
    const action = o.getSubcommand();
    if (action === 'listar') {
      const duties = operations.duties(i.guildId, opActor).slice(0, 25);
      await i.editReply({ content: duties.map(d => `<@${d.userId}> • ${d.kind === 'mediator' ? 'mediador' : 'analista'} • até <t:${Math.floor(d.expiresAt / 1000)}:R>`).join('\n') || 'Nenhum plantão ativo.', allowedMentions: noMentions });
    } else if (action === 'entrar') {
      const duty = operations.enterDuty(i.guildId, opActor, str('tipo') as DutyKind, o.getInteger('minutos') ?? 240);
      await i.editReply(`Plantão ativo até <t:${Math.floor(duty.expiresAt / 1000)}:f>.`);
    } else {
      operations.leaveDuty(i.guildId, opActor, str('tipo') as DutyKind);
      await i.editReply('Seu plantão foi encerrado.');
    }
    return true;
  }
  if (i.commandName === 'analise') {
    const action = o.getSubcommand();
    if (action === 'listar') {
      const cases = operations.analyses(i.guildId, opActor).slice(0, 20);
      await i.editReply({ content: cases.map(a => `\`${a.id}\` • ${a.state} • partida \`${a.matchId}\``).join('\n') || 'Nenhuma análise disponível.', allowedMentions: noMentions });
      return true;
    }
    let analysis: Analysis;
    if (action === 'solicitar') analysis = operations.requestAnalysis(i.guildId, str('partida'), opActor, o.getUser('jogador', true).id, str('motivo'), o.getAttachment('evidencia')?.url ?? null);
    else if (action === 'assumir') analysis = operations.claimAnalysis(i.guildId, str('id'), opActor);
    else if (action === 'decidir') analysis = operations.decideAnalysis(i.guildId, str('id'), opActor, str('conclusao') as AnalysisOutcome, str('justificativa'));
    else analysis = operations.analysis(i.guildId, str('id'), opActor);
    await i.editReply({ embeds: [analysisEmbed(analysis)], allowedMentions: noMentions });
    return true;
  }
  const target = o.getUser('jogador')?.id ?? actor.userId;
  const profile = operations.profile(i.guildId, target, opActor);
  const embed = new EmbedBuilder().setColor(0xff8c42).setTitle('Perfil de partidas')
    .setDescription(`<@${target}>`).addFields(
      { name: 'Partidas encerradas', value: String(profile.played), inline: true },
      { name: 'Vitórias / derrotas', value: `${profile.wins} / ${profile.losses}`, inline: true },
      { name: 'Aproveitamento', value: `${profile.winRate.toFixed(2).replace('.', ',')}%`, inline: true },
    );
  if (profile.active !== undefined) embed.addFields({ name: 'Situação atual', value: profile.active?.matchId ? `Partida: \`${profile.active.matchId}\`` : profile.active?.queueId ? 'Em fila.' : 'Sem fila ou partida ativa.' });
  if (profile.ticketsOpened !== undefined) embed.addFields({ name: 'Atendimentos solicitados', value: String(profile.ticketsOpened) });
  await i.editReply({ embeds: [embed], allowedMentions: noMentions });
  return true;
}
