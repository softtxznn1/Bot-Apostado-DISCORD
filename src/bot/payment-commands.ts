import { SlashCommandBuilder } from 'discord.js';

const matchOption = (s: import('discord.js').SlashCommandSubcommandBuilder) => s.addStringOption(o => o.setName('partida').setDescription('ID completo da partida').setRequired(true));
const movementOptions = (s: import('discord.js').SlashCommandSubcommandBuilder, player = true) => {
  matchOption(s);
  if (player) s.addUserOption(o => o.setName('jogador').setDescription('Jogador que recebeu/enviou a transferência').setRequired(true));
  return s.addStringOption(o => o.setName('valor').setDescription('Valor exato em reais, como 2,50').setRequired(true).setMaxLength(9))
    .addStringOption(o => o.setName('referencia').setDescription('Referência não secreta da transferência já conferida fora do bot').setRequired(true).setMinLength(3).setMaxLength(120));
};

export const paymentCommands = [new SlashCommandBuilder().setName('financeiro').setDescription('Registros financeiros manuais; não gera PIX nem movimenta dinheiro')
  .addSubcommand(s => matchOption(s.setName('configurar').setDescription('Fixa taxa antes da sala; 100 pontos-base = 1%'))
    .addIntegerOption(o => o.setName('taxa').setDescription('Taxa em pontos-base, de 0 a 10000').setRequired(true).setMinValue(0).setMaxValue(10000)))
  .addSubcommand(s => matchOption(s.setName('cobrar').setDescription('Consulta a instrução de conferência; não gera cobrança bancária'))
    .addUserOption(o => o.setName('jogador').setDescription('Apenas staff pode consultar outro jogador')))
  .addSubcommand(s => movementOptions(s.setName('confirmar').setDescription('Registra recebimento manual já conferido na instituição financeira')))
  .addSubcommand(s => matchOption(s.setName('resumo').setDescription('Mostra valores e conferências da partida, sem referências bancárias')))
  .addSubcommand(s => movementOptions(s.setName('estornar').setDescription('Registra estorno manual integral após cancelar a partida')))
  .addSubcommand(s => movementOptions(s.setName('premiar').setDescription('Registra prêmio manual já transferido ao vencedor após resultado final')))
  .addSubcommand(s => movementOptions(s.setName('taxa').setDescription('Registra retirada manual da taxa já transferida após resultado final'), false))
  .addSubcommand(s => matchOption(s.setName('historico').setDescription('Equipe: consulta referências de movimentações manuais')))
].map(c => c.toJSON());
