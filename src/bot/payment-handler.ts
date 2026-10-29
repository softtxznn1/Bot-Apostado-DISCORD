import { type ChatInputCommandInteraction } from 'discord.js';
import { money, parseMoney, type Actor } from '../domain.js';
import { BotService } from '../service.js';
import { PaymentsService, type FinanceSummary } from '../payments.js';

export function financeSummaryText(summary: FinanceSummary): string {
  const plan = summary.plan;
  return [
    summary.source === 'manual_records' ? '**Conferência manual — o bot não consulta saldo bancário nem transfere fundos neste fluxo.**' : '**Recebimentos verificados no provedor e/ou conferências manuais identificadas. Saídas registradas manualmente.**',
    `Estado: ${summary.status}`,
    `Combinado por jogador: ${money(plan.stakeCents)} • Total previsto: ${money(plan.expectedTotalCents)}`,
    `Taxa fixada: ${(plan.feeBasisPoints / 100).toLocaleString('pt-BR')}% (${money(plan.feeCents)}) • Prêmio previsto: ${money(plan.prizeCents)}`,
    `Recebimentos conferidos: ${money(summary.receivedCents)} • Estornos registrados: ${money(summary.refundedCents)}`,
    `Prêmios registrados: ${money(summary.prizesPaidCents)} • Taxa retirada: ${money(summary.feesPaidCents)}`,
    `Custódia conforme os registros: ${money(summary.recordedCustodyCents)}`,
    ...summary.players.map(p => `<@${p.userId}> • recebido ${money(p.receivedCents)} • prêmio devido ${money(p.prizeDueCents)} • prêmio registrado ${money(p.prizePaidCents)}`),
  ].join('\n');
}

export async function handlePayment(i: ChatInputCommandInteraction<'cached'>, actor: Actor, _service: BotService, payments: PaymentsService): Promise<boolean> {
  if (i.commandName !== 'financeiro') return false;
  const o = i.options; const matchId = o.getString('partida', true); const sub = o.getSubcommand();
  const reply = async (content: string) => { await i.editReply({ content, allowedMentions: { parse: [] } }); };
  if (sub === 'configurar') {
    const plan = payments.configurePlan(i.guildId, matchId, actor, o.getInteger('taxa', true));
    await reply(`Plano imutável registrado. Total ${money(plan.expectedTotalCents)}, taxa ${money(plan.feeCents)}, prêmio ${money(plan.prizeCents)}. Os participantes podem consultar /financeiro cobrar. Nenhuma cobrança bancária foi criada.`);
  } else if (sub === 'cobrar') {
    const charge = payments.charge(i.guildId, matchId, actor, o.getUser('jogador')?.id ?? actor.userId);
    await reply(`Conferência manual de <@${charge.userId}>: ${money(charge.amountCents)}. Taxa da partida ${(charge.plan.feeBasisPoints / 100).toLocaleString('pt-BR')}%. Combine os dados de pagamento com o mediador pelo canal privado. Este comando não gera PIX nem confirma recebimento.`);
  } else if (sub === 'resumo') await reply(financeSummaryText(payments.summary(i.guildId, matchId, actor)));
  else if (sub === 'historico') {
    const rows = payments.history(i.guildId, matchId, actor);
    await reply(rows.length ? `Últimos ${Math.min(rows.length, 6)} de ${rows.length} registros manuais:\n${rows.slice(-6).map(r => `${r.kind} • ${money(r.amountCents)} • referência \`${r.reference}\` • conferido por <@${r.actorId}>`).join('\n')}` : 'Nenhum registro financeiro.');
  } else {
    const cents = parseMoney(o.getString('valor', true));
    const reference = o.getString('referencia', true).trim();
    const key = `${sub}:${reference}`;
    if (sub === 'confirmar') payments.confirmReceipt(i.guildId, matchId, actor, o.getUser('jogador', true).id, cents, reference, key);
    else if (sub === 'estornar') payments.refund(i.guildId, matchId, actor, o.getUser('jogador', true).id, cents, reference, key);
    else if (sub === 'premiar') payments.payPrize(i.guildId, matchId, actor, o.getUser('jogador', true).id, cents, reference, key);
    else payments.payFee(i.guildId, matchId, actor, cents, reference, key);
    await reply('Conferência manual registrada e auditada. Nenhuma transferência foi executada pelo bot.');
  }
  return true;
}
