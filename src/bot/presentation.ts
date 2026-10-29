import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { money, type Match, type Queue } from '../domain.js';

const stateLabels: Record<Match['state'], string> = {
  confirming: 'Aguardando confirmação', awaiting_mediator: 'Aguardando mediador', ready: 'Pronta para receber sala',
  room_pending: 'Criação de sala pendente de verificação', room_created: 'Sala disponível', playing: 'Em jogo',
  result_pending: 'Resultado aguardando representantes', disputed: 'Resultado contestado', finished: 'Encerrada', cancelled: 'Cancelada', expired: 'Confirmação expirada',
};
export const noMentions = { parse: [] as never[] };
export const queueButtons = (id: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`q:join:${id}`).setLabel('Entrar na fila').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`q:leave:${id}`).setLabel('Sair da fila').setStyle(ButtonStyle.Secondary),
);
export function queueEmbed(q: Queue, players: string[]): EmbedBuilder {
  return new EmbedBuilder().setTitle(`Free Fire • ${q.teamSize}x${q.teamSize} • ${q.platform}`)
    .setColor(0xff8c42).setDescription(q.rules)
    .addFields(
      { name: 'Valor combinado por jogador', value: `${money(q.stakeCents)} • sem cobrança pelo bot` },
      { name: `Fila (${players.length}/${q.teamSize * 2})`, value: players.map(p => `<@${p}>`).join('\n') || 'Aguardando jogadores.' },
    ).setFooter({ text: 'Inscrição individual • confirme apenas se aceitar as regras' });
}
export function matchEmbed(m: Match): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(`Partida ${m.id.slice(0, 8)} • ${stateLabels[m.state]}`).setColor(0x5865f2)
    .setDescription(m.rules).addFields(
      { name: 'Modo', value: `${m.teamSize}x${m.teamSize} • ${m.platform}`, inline: true },
      { name: 'Valor por jogador', value: `${money(m.stakeCents)} • registro informativo`, inline: true },
      ...([1, 2] as const).map(team => ({ name: `Time ${team}`, value: m.players.filter(p => p.team === team).map((p, i) => `${p.confirmed ? '✅' : '⏳'} <@${p.userId}>${i === 0 ? ' • representante' : ''}`).join('\n'), inline: true })),
      { name: 'Mediador', value: m.mediatorId ? `<@${m.mediatorId}>` : 'Aguardando atribuição.' },
    ).setFooter({ text: `ID: ${m.id}` });
  if (m.state === 'confirming') embed.addFields({ name: 'Prazo', value: `<t:${Math.floor(m.expiresAt / 1000)}:R>` });
  if (m.room) embed.addFields({ name: m.room.source === 'simulated' ? '🧪 SIMULAÇÃO — não existe sala no jogo' : `Sala • origem ${m.room.source === 'manual' ? 'informada pelo mediador' : 'API'}`, value: `ID: \`${m.room.id}\`\nSenha: ||${m.room.password}||` });
  if (m.result) embed.addFields({ name: 'Resultado proposto', value: `Time ${m.result.winner} • ${m.result.score}\n${m.result.acceptedBy.length}/2 representantes confirmaram.` });
  if (m.result?.decision) embed.addFields({ name: 'Decisão da moderação', value: `Time ${m.result.decision.winner}\n${m.result.decision.reason}` });
  if (m.reason) embed.addFields({ name: 'Motivo registrado', value: m.reason });
  return embed;
}
export function matchButtons(m: Match): ActionRowBuilder<ButtonBuilder>[] {
  if (m.state === 'confirming') return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`m:confirm:${m.id}`).setLabel('Confirmar participação').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`m:decline:${m.id}`).setLabel('Desistir').setStyle(ButtonStyle.Danger),
  )];
  if (m.state === 'result_pending') return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`m:accept:${m.id}`).setLabel('Confirmar resultado (representante)').setStyle(ButtonStyle.Success),
  )];
  return [];
}
