import { SlashCommandBuilder } from 'discord.js';

const regular = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description);
const idOption = (name = 'id') => (o: import('discord.js').SlashCommandStringOption) => o.setName(name).setDescription('ID completo').setRequired(true);

export const operationsCommands = [
  regular('ticket', 'Abre e acompanha atendimento privado')
    .addSubcommand(s => s.setName('abrir').setDescription('Abre um ticket de suporte ou recupera seu ticket ativo')
      .addStringOption(o => o.setName('titulo').setDescription('Resumo do pedido').setRequired(true).setMinLength(3).setMaxLength(100))
      .addStringOption(o => o.setName('descricao').setDescription('Explique o que precisa, sem tokens ou senhas').setRequired(true).setMinLength(5).setMaxLength(1500)))
    .addSubcommand(s => s.setName('listar').setDescription('Lista seus tickets e os atendimentos disponíveis à equipe'))
    .addSubcommand(s => s.setName('ver').setDescription('Consulta um ticket privado e recupera seu canal').addStringOption(idOption()))
    .addSubcommand(s => s.setName('assumir').setDescription('Equipe: assume atendimento de um ticket').addStringOption(idOption()))
    .addSubcommand(s => s.setName('fechar').setDescription('Encerra o ticket com uma justificativa')
      .addStringOption(idOption()).addStringOption(o => o.setName('motivo').setDescription('Justificativa do encerramento').setRequired(true).setMinLength(3).setMaxLength(300))),
  regular('plantao', 'Gerencia a disponibilidade de mediadores e analistas')
    .addSubcommand(s => s.setName('entrar').setDescription('Inicia ou renova seu plantão')
      .addStringOption(o => o.setName('tipo').setDescription('Função no plantão').setRequired(true).addChoices({ name: 'Mediador', value: 'mediator' }, { name: 'Analista', value: 'analyst' }))
      .addIntegerOption(o => o.setName('minutos').setDescription('Duração de 15 a 1440 minutos; padrão 240').setMinValue(15).setMaxValue(1440)))
    .addSubcommand(s => s.setName('sair').setDescription('Encerra seu plantão')
      .addStringOption(o => o.setName('tipo').setDescription('Função no plantão').setRequired(true).addChoices({ name: 'Mediador', value: 'mediator' }, { name: 'Analista', value: 'analyst' })))
    .addSubcommand(s => s.setName('listar').setDescription('Equipe: lista os plantões ativos do servidor')),
  regular('analise', 'Solicita e acompanha a avaliação humana de uma partida')
    .addSubcommand(s => s.setName('solicitar').setDescription('Solicita avaliação de um participante da sua partida')
      .addStringOption(idOption('partida'))
      .addUserOption(o => o.setName('jogador').setDescription('Participante a ser analisado').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('O que precisa ser avaliado').setRequired(true).setMinLength(5).setMaxLength(1000))
      .addAttachmentOption(o => o.setName('evidencia').setDescription('Anexo opcional para o analista')))
    .addSubcommand(s => s.setName('listar').setDescription('Lista solicitações acessíveis a você'))
    .addSubcommand(s => s.setName('ver').setDescription('Consulta detalhes de uma análise privada').addStringOption(idOption()))
    .addSubcommand(s => s.setName('assumir').setDescription('Analista: assume uma solicitação').addStringOption(idOption()))
    .addSubcommand(s => s.setName('decidir').setDescription('Analista atribuído: registra conclusão humana e justificativa')
      .addStringOption(idOption())
      .addStringOption(o => o.setName('conclusao').setDescription('Conclusão da avaliação').setRequired(true).addChoices(
        { name: 'Sem irregularidade constatada', value: 'approved' }, { name: 'Irregularidade constatada', value: 'irregularity' }, { name: 'Inconclusiva', value: 'inconclusive' }))
      .addStringOption(o => o.setName('justificativa').setDescription('Fundamentação da decisão').setRequired(true).setMinLength(5).setMaxLength(1500))),
  regular('perfil', 'Consulta as estatísticas de partidas de um jogador')
    .addUserOption(o => o.setName('jogador').setDescription('Padrão: seu próprio perfil')),
].map(command => command.toJSON());
