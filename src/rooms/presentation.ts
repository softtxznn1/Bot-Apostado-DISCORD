import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { ManagedRoom } from './types.js';
import type { SafeManagedRoom } from './service.js';

export const roomNoMentions = { parse: [] as never[] };
export const roomStateLabels: Record<ManagedRoom['state'], string> = {
  draft: 'Rascunho', creating: 'Criação pendente', ready: 'Disponível', running: 'Em andamento',
  updating: 'Atualização pendente', cancelling: 'Cancelamento pendente', closing: 'Encerramento pendente',
  cancelled: 'Cancelada', closed: 'Encerrada', expired: 'Expirada', uncertain: 'Aguardando verificação', failed: 'Falha confirmada',
};
const clean = (value: string, limit = 1000) => escapeMarkdown(value).slice(0, limit);
export function roomPanel(guildId = '') {
  const embed = new EmbedBuilder().setTitle('Salas Free Fire').setDescription('Crie e gerencie salas pelo painel. Escolha modo, mapa, capacidade e as opções disponíveis no provedor. As permissões são verificadas em cada ação.')
    .setColor(0x5865f2).setFooter({ text: `ROOM_PANEL:${guildId}` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('room:new').setLabel('Criar sala').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('room:mine:1').setLabel('Minhas salas').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('room:lookup').setLabel('Consultar sala').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('room:list:1').setLabel('Atualizar lista').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: roomNoMentions };
}

export function roomEmbed(room: ManagedRoom | SafeManagedRoom, includeSecrets = false): EmbedBuilder {
  const applied = room.confirmed ?? room.options;
  const embed = new EmbedBuilder().setTitle(`${room.source === 'simulated' ? '🧪 SIMULAÇÃO • ' : ''}${clean(applied.name, 130)}`)
    .setColor(room.state === 'uncertain' || room.lastErrorCode ? 0xe6a23c : 0x5865f2)
    .addFields(
      { name: 'Estado', value: roomStateLabels[room.state], inline: true },
      { name: 'Modo', value: clean(applied.modeId, 100), inline: true },
      { name: 'Mapa', value: clean(applied.mapId, 100), inline: true },
      { name: 'Capacidade', value: String(applied.maxPlayers), inline: true },
      { name: 'Criador', value: `<@${room.creatorId}>`, inline: true },
    ).setFooter({ text: `ROOM:${room.id}` });
  if (room.source === 'simulated') embed.setDescription('Demonstração identificada. Não existe sala real no Free Fire.');
  if (room.confirmed) {
    embed.addFields({ name: 'ID da sala', value: `\`${clean(room.confirmed.id, 100)}\``, inline: true });
    const secret = 'password' in room.confirmed ? room.confirmed.password : undefined;
    if (includeSecrets && secret !== undefined) embed.addFields({ name: 'Senha', value: secret === null ? 'Sem senha' : `||${clean(secret, 100)}||`, inline: true });
    else embed.addFields({ name: 'Senha', value: 'Disponível apenas aos operadores autorizados.', inline: true });
  } else embed.addFields({ name: 'Dados de entrada', value: 'Aguardando confirmação de criação pelo provedor.' });
  const options = Object.entries(applied.extras).map(([key, value]) => `${clean(key, 60)}: ${clean(String(value), 120)}`).join('\n');
  if (options) embed.addFields({ name: 'Opções', value: options.slice(0, 1000) });
  if (room.pending) embed.addFields({ name: 'Operação pendente', value: 'Aguardando confirmação remota. O último estado confirmado não equivale à conclusão desta operação.' });
  if (room.lastSyncedAt) embed.addFields({ name: 'Última sincronização confirmada', value: `<t:${Math.floor(room.lastSyncedAt / 1000)}:F>` });
  if (room.lastErrorCode) embed.addFields({ name: 'Verificação necessária', value: 'A última operação ou sincronização precisa de verificação. Nenhum novo sucesso foi presumido.' });
  if (room.confirmed?.expiresAt) embed.addFields({ name: 'Validade', value: `<t:${Math.floor(room.confirmed.expiresAt / 1000)}:F>` });
  return embed;
}

export function roomControls(room: ManagedRoom | SafeManagedRoom): ActionRowBuilder<ButtonBuilder>[] {
  const terminal = ['cancelled', 'closed', 'expired', 'failed'].includes(room.state);
  const pending = !!room.pending || ['creating', 'updating', 'cancelling', 'closing', 'uncertain'].includes(room.state);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`room:sync:${room.id}`).setLabel('Consultar estado').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`room:edit:${room.id}`).setLabel('Editar').setStyle(ButtonStyle.Primary).setDisabled(terminal || pending),
    new ButtonBuilder().setCustomId(`room:cancel:${room.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger).setDisabled(terminal || pending || room.state === 'running'),
    new ButtonBuilder().setCustomId(`room:close:${room.id}`).setLabel('Encerrar').setStyle(ButtonStyle.Danger).setDisabled(terminal || pending || !room.confirmed),
  )];
}
