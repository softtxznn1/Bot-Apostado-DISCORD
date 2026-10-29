import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { operationsCommands } from './operations-commands.js';
import { paymentCommands } from './payment-commands.js';

const admin = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
const regular = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description);

export const commands = [
  admin('configurar', 'Configura os cargos e a categoria das partidas')
    .addChannelOption(o => o.setName('categoria').setDescription('Categoria para canais privados').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption(o => o.setName('staff').setDescription('Cargo da moderação').setRequired(true))
    .addRoleOption(o => o.setName('mediador').setDescription('Cargo dos mediadores').setRequired(true))
    .addRoleOption(o => o.setName('analista').setDescription('Cargo dos analistas humanos')),
  admin('painel-fila', 'Publica um painel de fila neste canal')
    .addIntegerOption(o => o.setName('time').setDescription('Jogadores por time; inscrições individuais').setRequired(true).setMinValue(1).setMaxValue(4))
    .addStringOption(o => o.setName('plataforma').setDescription('Plataforma declarada pelos jogadores').setRequired(true).addChoices({ name: 'Mobile', value: 'mobile' }, { name: 'Emulador', value: 'emulador' }, { name: 'Misto', value: 'misto' }))
    .addStringOption(o => o.setName('regras').setDescription('Regras aceitas ao confirmar a partida').setRequired(true).setMinLength(3).setMaxLength(200))
    .addStringOption(o => o.setName('valor').setDescription('Valor combinado por jogador, como 2,50. O bot não cobra.').setMaxLength(9)),
  regular('fila', 'Consulta sua fila ou partida atual'),
  regular('partida', 'Consulta sua partida atual ou uma partida pelo ID')
    .addStringOption(o => o.setName('id').setDescription('ID completo da partida')),
  regular('mediador', 'Lista partidas aguardando mediador ou assume uma partida')
    .addSubcommand(s => s.setName('pendentes').setDescription('Lista IDs das partidas disponíveis'))
    .addSubcommand(s => s.setName('assumir').setDescription('Assume a partida').addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))),
  regular('sala', 'Gerencia a sala da partida')
    .addSubcommand(s => s.setName('criar').setDescription('Solicita sala via API configurada ou simulação identificada').addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true)))
    .addSubcommand(s => s.setName('reconciliar').setDescription('Consulta uma criação incerta sem repetir o pedido').addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true)))
    .addSubcommand(s => s.setName('informar').setDescription('Informa dados de uma sala criada no jogo')
      .addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))
      .addStringOption(o => o.setName('id').setDescription('ID real da sala').setRequired(true).setMaxLength(64))
      .addStringOption(o => o.setName('senha').setDescription('Senha da sala').setRequired(true).setMaxLength(64)))
    .addSubcommand(s => s.setName('iniciar').setDescription('Registra manualmente o início; não inicia o jogo por API').addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))),
  regular('resultado', 'Registra, contesta ou resolve o resultado de uma partida')
    .addSubcommand(s => s.setName('registrar').setDescription('Propõe o resultado para os representantes confirmarem')
      .addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))
      .addIntegerOption(o => o.setName('vencedor').setDescription('Time vencedor').setRequired(true).addChoices({ name: 'Time 1', value: 1 }, { name: 'Time 2', value: 2 }))
      .addStringOption(o => o.setName('placar').setDescription('Time 1 x time 2, como 7x3').setRequired(true).setMaxLength(12)))
    .addSubcommand(s => s.setName('contestar').setDescription('Contesta o resultado antes do encerramento')
      .addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Justificativa').setRequired(true).setMinLength(3).setMaxLength(300)))
    .addSubcommand(s => s.setName('resolver').setDescription('Moderação: decide uma disputa, preservando o placar proposto')
      .addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))
      .addIntegerOption(o => o.setName('vencedor').setDescription('Time vencedor').setRequired(true).addChoices({ name: 'Time 1', value: 1 }, { name: 'Time 2', value: 2 }))
      .addStringOption(o => o.setName('motivo').setDescription('Justificativa da decisão').setRequired(true).setMinLength(3).setMaxLength(300))),
  regular('cancelar', 'Cancela uma partida com justificativa')
    .addStringOption(o => o.setName('partida').setDescription('ID completo').setRequired(true))
    .addStringOption(o => o.setName('motivo').setDescription('Justificativa').setRequired(true).setMinLength(3).setMaxLength(300)),
  regular('ranking', 'Mostra vitórias e derrotas de partidas encerradas neste servidor'),
  regular('pix', 'Gera e consulta PIX por um provedor financeiro configurado')
    .addSubcommand(s => s.setName('gerar').setDescription('Gera uma cobrança vinculada à sua participação')
      .addStringOption(o => o.setName('partida').setDescription('ID da partida com plano financeiro').setRequired(true))
      .addStringOption(o => o.setName('provedor').setDescription('Provedor financeiro').addChoices({ name: 'Mercado Pago', value: 'mercadopago' }, { name: 'Efí', value: 'efi' }))
      .addStringOption(o => o.setName('email').setDescription('E-mail do pagador, exigido pelo Mercado Pago').setMaxLength(254))
      .addUserOption(o => o.setName('jogador').setDescription('Equipe: cobrar outro participante')))
    .addSubcommand(s => s.setName('consultar').setDescription('Consulta o provedor e concilia sua cobrança')
      .addStringOption(o => o.setName('id').setDescription('ID interno da cobrança').setRequired(true))
      .addStringOption(o => o.setName('provedor').setDescription('Provedor financeiro').addChoices({ name: 'Mercado Pago', value: 'mercadopago' }, { name: 'Efí', value: 'efi' }))),
  regular('blacklist', 'Moderação: bloqueia ou desbloqueia um jogador')
    .addUserOption(o => o.setName('jogador').setDescription('Jogador').setRequired(true))
    .addStringOption(o => o.setName('acao').setDescription('Ação').setRequired(true).addChoices({ name: 'Bloquear', value: 'add' }, { name: 'Desbloquear', value: 'remove' }))
    .addStringOption(o => o.setName('motivo').setDescription('Obrigatório para bloquear').setMinLength(3).setMaxLength(300)),
  regular('status', 'Equipe: mostra modo de salas e pendências do servidor'),
  regular('tarefas', 'Moderação: revisa entregas pendentes ou falhas')
    .addSubcommand(s => s.setName('listar').setDescription('Lista tarefas pendentes deste servidor'))
    .addSubcommand(s => s.setName('repetir').setDescription('Repete uma tarefa após corrigir a causa').addStringOption(o => o.setName('chave').setDescription('Chave completa exibida na lista').setRequired(true))),
].map(c => c.toJSON()).concat(operationsCommands, paymentCommands);
