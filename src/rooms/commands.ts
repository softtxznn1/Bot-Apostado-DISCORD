import { ChannelType, SlashCommandBuilder } from 'discord.js';

const id = (o: import('discord.js').SlashCommandStringOption) => o.setName('id').setDescription('ID interno da sala exibido pelo bot').setRequired(true);
const room = new SlashCommandBuilder().setName('sala').setDescription('Cria e gerencia salas Free Fire');
for (const [name, description] of [
  ['criar', 'Abre o assistente de modo, mapa e capacidade'],
  ['consultar', 'Consulta detalhes autorizados e sincroniza o estado'],
  ['status', 'Consulta o estado confirmado da sala'],
  ['atualizar', 'Edita opções permitidas pelo provedor'],
  ['cancelar', 'Solicita cancelamento da sala com confirmação'],
  ['encerrar', 'Solicita encerramento da sala com confirmação'],
] as const) {
  room.addSubcommand(s => {
    s.setName(name).setDescription(description);
    if (name !== 'criar') s.addStringOption(id);
    return s;
  });
}
const rooms = new SlashCommandBuilder().setName('salas').setDescription('Painel, histórico e configuração de salas')
  .addSubcommand(s => s.setName('configurar').setDescription('Administração: configura canais, cargos, catálogo e limites')
    .addChannelOption(o => o.setName('painel').setDescription('Canal do painel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption(o => o.setName('publicacao').setDescription('Canal autorizado para publicar dados das salas').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('operador').setDescription('Cargo que cria e gerencia as próprias salas').setRequired(true))
    .addRoleOption(o => o.setName('gerente').setDescription('Cargo que gerencia todas as salas'))
    .addRoleOption(o => o.setName('visualizador').setDescription('Cargo de consulta sem acesso a senhas'))
    .addChannelOption(o => o.setName('logs').setDescription('Canal restrito de eventos sem senhas').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('modos').setDescription('IDs separados por vírgula; omitido conserva a seleção atual').setMaxLength(1500))
    .addStringOption(o => o.setName('mapas').setDescription('IDs separados por vírgula; omitido conserva a seleção atual').setMaxLength(1500))
    .addStringOption(o => o.setName('extras').setDescription('IDs de opções extras separados por vírgula; * libera o catálogo').setMaxLength(1500))
    .addIntegerOption(o => o.setName('limite_usuario').setDescription('Máximo de salas ativas por criador').setMinValue(1).setMaxValue(100))
    .addIntegerOption(o => o.setName('limite_servidor').setDescription('Máximo de salas ativas neste servidor').setMinValue(1).setMaxValue(1000))
    .addIntegerOption(o => o.setName('intervalo').setDescription('Segundos entre criações do mesmo usuário').setMinValue(0).setMaxValue(3600)))
  .addSubcommand(s => s.setName('cargos').setDescription('Administração: adiciona ou remove cargos de uma função')
    .addStringOption(o => o.setName('grupo').setDescription('Função').setRequired(true).addChoices({ name: 'Operadores', value: 'operatorRoleIds' }, { name: 'Gerentes', value: 'managerRoleIds' }, { name: 'Visualizadores', value: 'viewerRoleIds' }))
    .addStringOption(o => o.setName('acao').setDescription('Ação').setRequired(true).addChoices({ name: 'Adicionar', value: 'add' }, { name: 'Remover', value: 'remove' }))
    .addRoleOption(o => o.setName('cargo').setDescription('Cargo selecionado').setRequired(true)))
  .addSubcommand(s => s.setName('painel').setDescription('Administração: publica ou recupera o painel'))
  .addSubcommand(s => s.setName('diagnostico').setDescription('Gerência: consulta falhas e estado das entregas deste servidor')
    .addIntegerOption(o => o.setName('pagina').setDescription('Página de tarefas').setMinValue(1)))
  .addSubcommand(s => s.setName('reprocessar').setDescription('Gerência: recupera uma entrega com tentativas esgotadas')
    .addStringOption(o => o.setName('tarefa').setDescription('Referência exibida em /salas diagnostico').setRequired(true).setMinLength(32).setMaxLength(32))
    .addStringOption(o => o.setName('motivo').setDescription('Correção que permite tentar novamente a entrega').setRequired(true).setMinLength(3).setMaxLength(300)))
  .addSubcommand(s => s.setName('catalogo').setDescription('Mostra os modos, mapas e opções do catálogo permitido'))
  .addSubcommand(s => s.setName('minhas').setDescription('Lista suas salas com paginação').addIntegerOption(o => o.setName('pagina').setDescription('Página').setMinValue(1)))
  .addSubcommand(s => s.setName('historico').setDescription('Lista salas autorizadas com filtros')
    .addIntegerOption(o => o.setName('pagina').setDescription('Página').setMinValue(1))
    .addUserOption(o => o.setName('criador').setDescription('Filtrar por criador'))
    .addStringOption(o => o.setName('estado').setDescription('Estado interno da sala').addChoices(...['draft', 'creating', 'ready', 'running', 'updating', 'cancelling', 'closing', 'cancelled', 'closed', 'expired', 'uncertain', 'failed'].map(value => ({ name: value, value })))))
  .addSubcommand(s => s.setName('sincronizar').setDescription('Consulta e reconcilia uma sala autorizada').addStringOption(id));

export const roomCommands = [room.toJSON(), rooms.toJSON()];
