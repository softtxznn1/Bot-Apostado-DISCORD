import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { PaymentHub } from '../payment-hub.js';
import { money, type Actor } from '../domain.js';
import type { BillingIntent } from '../billing.js';

export async function handlePix(i: ChatInputCommandInteraction<'cached'>, actor: Actor, hub: PaymentHub): Promise<boolean> {
  if (i.commandName !== 'pix') return false;
  const provider = i.options.getString('provedor') ?? undefined;
  const billing = hub.billing(provider);
  let intent: BillingIntent;
  if (i.options.getSubcommand() === 'gerar') {
    intent = await billing.requestCharge(i.guildId, i.options.getString('partida', true), actor,
      i.options.getString('email') ?? '', i.options.getUser('jogador')?.id ?? actor.userId);
  } else intent = await billing.reconcile(i.guildId, i.options.getString('id', true), actor);
  const files: AttachmentBuilder[] = [];
  if (intent.pixCopyPaste) files.push(new AttachmentBuilder(Buffer.from(intent.pixCopyPaste, 'utf8'), { name: 'pix-copia-e-cola.txt' }));
  if (intent.qrCode && intent.qrCode.length <= 1_400_000) {
    const image = Buffer.from(intent.qrCode, 'base64');
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) files.push(new AttachmentBuilder(image, { name: 'pix.png' }));
  }
  const content = [`Provedor: **${intent.provider}** • Valor: **${money(intent.amountCents)}**`,
    `Cobrança: \`${intent.id}\` • Estado: **${intent.status}**`,
    intent.creditedAt ? 'Recebimento confirmado por consulta autenticada ao provedor.' : 'Aguarde a confirmação do provedor. E-mail ou comprovante não confirma recebimento.',
    intent.reviewReason ? 'Esta cobrança exige revisão da moderação.' : '',
    intent.pixCopyPaste ? 'O código PIX está no arquivo privado anexado.' : '',
  ].filter(Boolean).join('\n');
  await i.editReply({ content, files, allowedMentions: { parse: [] } }); return true;
}
