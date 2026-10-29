import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, DiscordAPIError, PermissionFlagsBits, type APIEmbed, type EmbedBuilder, type Guild } from 'discord.js';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { DomainError } from '../src/domain.js';
import { OperationsService, type OperationsActor } from '../src/operations.js';
import { operationsCommands } from '../src/bot/operations-commands.js';
import { syncTicketChannel } from '../src/bot/operations-handler.js';

const admin: OperationsActor = { userId: 'admin', moderator: true, mediator: false };
const med: OperationsActor = { userId: 'mediator', moderator: false, mediator: true };
const analyst: OperationsActor = { userId: 'analyst', moderator: false, mediator: false, analyst: true };
const otherAnalyst: OperationsActor = { ...analyst, userId: 'other-analyst' };
const user = (id: string): OperationsActor => ({ userId: id, moderator: false, mediator: false });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

function setup(t: TestContext, now: () => number = Date.now) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const bot = new BotService(store, 180_000, now);
  bot.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med', analystRoleId: 'analyst-role' }, admin);
  const operations = new OperationsService(store, bot, now);
  return { store, bot, operations };
}
function form(bot: BotService, size = 1) {
  const queue = bot.createQueue('guild', admin, size, 'mobile', 'Teste operacional com participantes individuais.');
  for (let i = 0; i < size * 2 - 1; i++) bot.joinQueue('guild', queue.id, `p${i}`);
  return bot.joinQueue('guild', queue.id, `p${size * 2 - 1}`).match!;
}

test('ticket ativo é recuperado sem duplicação, com dados privados e isolamento por servidor', t => {
  const { operations } = setup(t);
  const ticket = operations.openTicket('guild', user('p1'), 'Problema na fila', 'Não consigo entrar na fila desejada.');
  assert.equal(operations.openTicket('guild', user('p1'), 'Outro título', 'Mesmo usuário ainda tem um ticket aberto.').id, ticket.id);
  assert.equal(operations.tickets('guild', user('p1')).length, 1);
  assert.equal(operations.tickets('guild', user('p2')).length, 0);
  assert.throws(() => operations.ticket('guild', ticket.id, user('p2')), code('FORBIDDEN'));
  assert.throws(() => operations.ticket('other-guild', ticket.id, admin), code('NOT_FOUND'));
});

test('um mediador pode ver resumo disponível, mas só lê o conteúdo privado depois de assumir', t => {
  const { operations } = setup(t);
  const ticket = operations.openTicket('guild', user('p1'), 'Atendimento', 'Conteúdo privado do solicitante.');
  const summary = operations.tickets('guild', med)[0]!;
  assert.equal(summary.id, ticket.id);
  assert.ok(!JSON.stringify(summary).includes('Conteúdo privado'));
  assert.throws(() => operations.ticket('guild', ticket.id, med), code('FORBIDDEN'));
  assert.throws(() => operations.claimTicket('guild', ticket.id, user('p2')), code('FORBIDDEN'));
  operations.claimTicket('guild', ticket.id, med);
  assert.equal(operations.ticket('guild', ticket.id, med).description, 'Conteúdo privado do solicitante.');
  assert.throws(() => operations.claimTicket('guild', ticket.id, admin), code('INVALID_STATE'));
  assert.equal(operations.claimTicket('guild', ticket.id, med).assignedTo, med.userId);
  const revoked = { ...med, mediator: false };
  assert.throws(() => operations.ticket('guild', ticket.id, revoked), code('FORBIDDEN'));
  assert.throws(() => operations.closeTicket('guild', ticket.id, revoked, 'Tentativa após perder o cargo.'), code('FORBIDDEN'));
});

test('ticket é encerrado com motivo, sem duplicar eventos e pode ser substituído por novo atendimento', t => {
  const { operations, store } = setup(t);
  const ticket = operations.openTicket('guild', user('p1'), 'Atendimento', 'Preciso de atendimento sobre a partida.');
  assert.throws(() => operations.closeTicket('guild', ticket.id, user('p2'), 'Encerramento indevido.'), code('FORBIDDEN'));
  operations.claimTicket('guild', ticket.id, med);
  const closed = operations.closeTicket('guild', ticket.id, med, 'Dúvida esclarecida.');
  assert.equal(closed.state, 'closed'); assert.equal(closed.closeReason, 'Dúvida esclarecida.');
  operations.closeTicket('guild', ticket.id, med, 'Pedido repetido.');
  const count = store.db.prepare("SELECT COUNT(*) AS total FROM operations_events WHERE action='ticket_closed'").get();
  assert.equal(count?.total, 1);
  const next = operations.openTicket('guild', user('p1'), 'Novo atendimento', 'Nova questão após o encerramento.');
  assert.notEqual(next.id, ticket.id);
});

test('plantões verificam o cargo por função e limitam a duração', t => {
  const { operations } = setup(t);
  assert.throws(() => operations.enterDuty('guild', user('p1'), 'mediator'), code('FORBIDDEN'));
  assert.throws(() => operations.enterDuty('guild', med, 'analyst'), code('FORBIDDEN'));
  assert.throws(() => operations.enterDuty('guild', analyst, 'mediator'), code('FORBIDDEN'));
  assert.throws(() => operations.enterDuty('guild', med, 'mediator', 0), code('INVALID_DURATION'));
  assert.throws(() => operations.enterDuty('guild', med, 'mediator', 1441), code('INVALID_DURATION'));
  operations.enterDuty('guild', med, 'mediator', 15);
  operations.enterDuty('guild', analyst, 'analyst', 30);
  assert.equal(operations.duties('guild', admin).length, 2);
  assert.throws(() => operations.duties('guild', user('p1')), code('FORBIDDEN'));
});

test('plantão expira uma única vez e a saída afeta somente a pessoa que a solicita', t => {
  let clock = 1_000;
  const { operations, store } = setup(t, () => clock);
  operations.enterDuty('guild', med, 'mediator', 15);
  operations.enterDuty('guild', analyst, 'analyst', 30);
  operations.leaveDuty('guild', user('p1'), 'mediator');
  assert.equal(operations.duties('guild', admin).length, 2);
  clock += 15 * 60_000;
  assert.equal(operations.expireDuties(), 1);
  assert.equal(operations.expireDuties(), 0);
  assert.equal(operations.duties('guild', admin)[0]?.userId, 'analyst');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM operations_events WHERE action='duty_expired'").get()?.count, 1);
  operations.leaveDuty('guild', analyst, 'analyst');
  assert.equal(operations.duties('guild', admin).length, 0);
});

test('análise exige acesso à partida e um sujeito participante', t => {
  const { operations, bot } = setup(t); const match = form(bot);
  assert.throws(() => operations.requestAnalysis('guild', match.id, user('outsider'), 'p1', 'Avaliar o comportamento reportado.'), code('FORBIDDEN'));
  assert.throws(() => operations.requestAnalysis('guild', match.id, user('p0'), 'outsider', 'Avaliar o comportamento reportado.'), code('INVALID_SUBJECT'));
  assert.throws(() => operations.requestAnalysis('other-guild', match.id, admin, 'p1', 'Avaliar o comportamento reportado.'), code('NOT_FOUND'));
  assert.throws(() => operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Avaliar a evidência.', 'http://127.0.0.1/private'), code('INVALID_EVIDENCE'));
  const analysis = operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Avaliar o comportamento reportado.', 'https://cdn.discordapp.com/attachments/example/evidence.mp4');
  assert.equal(analysis.state, 'open'); assert.equal(analysis.subjectId, 'p1');
});

test('caso ativo não duplica e outros participantes recebem apenas a existência da solicitação', t => {
  const { operations, bot } = setup(t); const match = form(bot, 2);
  const a = operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Conteúdo reservado ao analista e às partes.');
  assert.equal(operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Repetição de um pedido.').id, a.id);
  assert.throws(() => operations.requestAnalysis('guild', match.id, user('p2'), 'p1', 'Outra pessoa pede a mesma análise.'), code('ALREADY_REQUESTED'));
  assert.throws(() => operations.analysis('guild', a.id, user('p2')), code('FORBIDDEN'));
  const available = operations.analyses('guild', analyst)[0]!;
  assert.equal(available.id, a.id);
  assert.ok(!('reason' in available)); assert.ok(!('evidenceUrl' in available));
  assert.ok(!('requesterId' in available)); assert.ok(!('subjectId' in available));
});

test('assumir análise verifica cargo, conflito de interesse e exclusividade', t => {
  const { operations, bot } = setup(t); const match = form(bot);
  const a = operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Verificar as evidências disponíveis.');
  assert.throws(() => operations.claimAnalysis('guild', a.id, med), code('FORBIDDEN'));
  assert.throws(() => operations.claimAnalysis('guild', a.id, { ...admin, userId: 'p0' }), code('CONFLICT_OF_INTEREST'));
  assert.throws(() => operations.claimAnalysis('guild', a.id, { ...analyst, userId: 'p1' }), code('CONFLICT_OF_INTEREST'));
  assert.equal(operations.claimAnalysis('guild', a.id, analyst).assignedTo, analyst.userId);
  assert.throws(() => operations.claimAnalysis('guild', a.id, otherAnalyst), code('INVALID_STATE'));
});

test('somente o analista atribuído e autorizado decide; a conclusão não muda automaticamente o resultado do jogo', t => {
  const { operations, bot, store } = setup(t); const match = form(bot);
  const a = operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'Verificar as evidências disponíveis.');
  operations.claimAnalysis('guild', a.id, analyst);
  assert.throws(() => operations.analysis('guild', a.id, { ...analyst, analyst: false }), code('FORBIDDEN'));
  assert.throws(() => operations.decideAnalysis('guild', a.id, admin, 'approved', 'Não sou o analista atribuído.'), code('FORBIDDEN'));
  assert.throws(() => operations.decideAnalysis('guild', a.id, { ...analyst, analyst: false }, 'approved', 'O cargo foi removido.'), code('FORBIDDEN'));
  const result = operations.decideAnalysis('guild', a.id, analyst, 'irregularity', 'Evidência conferida manualmente pelo analista.');
  assert.equal(result.state, 'completed'); assert.equal(result.outcome, 'irregularity');
  operations.decideAnalysis('guild', a.id, analyst, 'irregularity', 'Evidência conferida manualmente pelo analista.');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM operations_events WHERE action='analysis_completed'").get()?.count, 1);
  assert.equal(bot.match('guild', match.id).state, 'confirming');
  assert.equal(bot.match('guild', match.id).result, null);
});

test('perfil de outro jogador mostra apenas estatísticas públicas, sem atividade ou atendimentos', t => {
  const { operations, bot } = setup(t); const match = form(bot);
  operations.openTicket('guild', user('p0'), 'Privacidade', 'Atendimento que não deve aparecer para terceiros.');
  const publicProfile = operations.profile('guild', 'p0', user('p1'));
  assert.equal(publicProfile.played, 0);
  assert.ok(!('active' in publicProfile)); assert.ok(!('ticketsOpened' in publicProfile));
  const own = operations.profile('guild', 'p0', user('p0'));
  assert.equal(own.active?.matchId, match.id); assert.equal(own.ticketsOpened, 1);
  assert.ok(!JSON.stringify(own).includes('password'));
});

test('estatísticas do perfil refletem apenas partidas encerradas e o vencedor definitivo', t => {
  const { operations, bot } = setup(t); const match = form(bot);
  bot.confirm('guild', match.id, 'p0'); bot.confirm('guild', match.id, 'p1');
  bot.claim('guild', match.id, med); bot.informRoom('guild', match.id, med, '123456', 'private');
  bot.startMatch('guild', match.id, med); bot.proposeResult('guild', match.id, med, 1, '7x3');
  assert.equal(operations.profile('guild', 'p0', user('p0')).played, 0);
  bot.dispute('guild', match.id, 'p1', 'Resultado precisa de revisão.');
  bot.resolve('guild', match.id, admin, 2, 'A evidência demonstra vitória do time dois.');
  assert.equal(operations.profile('guild', 'p1', user('p1')).winRate, 100);
  assert.equal(operations.profile('guild', 'p0', user('p0')).losses, 1);
});

test('tickets, análises, plantões e vínculo de canal sobrevivem à reabertura e à migração repetida', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-operations-'));
  let store: Store | undefined;
  t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
  const filename = join(dir, 'operations.sqlite');
  store = new Store(filename); let bot = new BotService(store);
  bot.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'med' }, admin);
  let operations = new OperationsService(store, bot); const match = form(bot);
  const ticket = operations.openTicket('guild', user('p0'), 'Persistência', 'O atendimento precisa sobreviver ao reinício.');
  operations.attachTicketChannel('guild', ticket.id, 'channel', 'message');
  operations.enterDuty('guild', med, 'mediator');
  const a = operations.requestAnalysis('guild', match.id, user('p0'), 'p1', 'A análise precisa sobreviver ao reinício.');
  operations.claimAnalysis('guild', a.id, analyst);
  store.close(); store = new Store(filename); bot = new BotService(store); operations = new OperationsService(store, bot);
  assert.equal(operations.ticket('guild', ticket.id, user('p0')).channelId, 'channel');
  assert.equal(operations.ticket('guild', ticket.id, user('p0')).messageId, 'message');
  assert.equal(operations.analysis('guild', a.id, analyst).assignedTo, analyst.userId);
  assert.equal(operations.duties('guild', admin).length, 1);
  const again = new OperationsService(store, bot);
  assert.equal(again.tickets('guild', user('p0')).length, 1);
});

test('comandos operacionais serializam sem nomes duplicados', () => {
  assert.deepEqual(operationsCommands.map(c => c.name), ['ticket', 'plantao', 'analise', 'perfil']);
  assert.equal(new Set(operationsCommands.map(c => c.name)).size, operationsCommands.length);
});

function discordTransport(t: TestContext) {
  const fixture = setup(t);
  const ticket = fixture.operations.openTicket('guild', user('owner'), 'Atendimento privado', 'Mensagem privada do atendimento de teste.');
  fixture.operations.claimTicket('guild', ticket.id, med);
  let channelExists = false; let messageExists = false; let revoked = false; let forbidden = false;
  let creates = 0; let sends = 0; let forcedReads = 0;
  let access: { id: string; allow?: bigint[]; deny?: bigint[] }[] = [];
  const apiError = (code: number, status: number) => new DiscordAPIError({ code, message: 'Resource unavailable' }, code, status, 'GET', 'https://discord.com/api/test', { body: undefined, files: undefined });
  const message = {
    id: 'ticket-message', author: { id: 'bot' }, embeds: [] as APIEmbed[],
    async edit(payload: { embeds: EmbedBuilder[] }) { this.embeds = payload.embeds.map(e => e.toJSON()); return this; },
  };
  const channel = {
    id: 'ticket-channel', type: ChannelType.GuildText, topic: `ops-ticket:${ticket.id}`,
    permissionOverwrites: { async set(value: typeof access) { access = value; } },
    messages: { async fetch(input: { message?: string; force?: boolean; limit?: number }) {
      if (forbidden) throw apiError(50013, 403);
      if (input.limit) return new Collection(messageExists ? [[message.id, message]] : []);
      assert.equal(input.force, true); forcedReads++;
      if (!messageExists) throw apiError(10008, 404);
      return message;
    } },
    async send(payload: { embeds: EmbedBuilder[] }) {
      assert.ok(access.some(a => a.id === 'guild' && a.deny?.includes(PermissionFlagsBits.ViewChannel)));
      sends++; messageExists = true; await message.edit(payload); return message;
    },
  };
  const guild = {
    id: 'guild',
    members: { async fetch() { return { id: med.userId, permissions: { has: () => false }, roles: { cache: new Collection(revoked ? [] : [['med', { id: 'med' }]]) } }; } },
    channels: {
      async fetch(id?: string, options?: { force: boolean }) {
        if (id) { assert.equal(options?.force, true); if (!channelExists) throw apiError(10003, 404); return channel; }
        return new Collection(channelExists ? [[channel.id, channel]] : []);
      },
      async create() { creates++; channelExists = true; return channel; },
    },
  } as unknown as Guild;
  return {
    ...fixture, ticket, guild,
    sync: () => syncTicketChannel(guild, 'bot', fixture.bot, fixture.operations, ticket.id),
    access: () => access, counts: () => ({ creates, sends, forcedReads }),
    revoke: () => { revoked = true; }, deleteMessage: () => { messageExists = false; },
    deleteChannel: () => { channelExists = false; messageExists = false; },
    denyRead: () => { forbidden = true; },
  };
}

test('canal de ticket reconcilia exclusões e revoga acesso mesmo quando o registro não mudou', async t => {
  const f = discordTransport(t); await f.sync();
  assert.ok(f.access().some(a => a.id === med.userId));
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().sends, 1);
  f.revoke(); await f.sync();
  assert.ok(!f.access().some(a => a.id === med.userId));
  f.deleteMessage(); await f.sync();
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().sends, 2);
  f.deleteChannel(); await f.sync();
  assert.equal(f.counts().creates, 2); assert.equal(f.counts().sends, 3);
  f.operations.closeTicket('guild', f.ticket.id, user('owner'), 'Atendimento resolvido.');
  await f.sync();
  assert.ok(f.access().some(a => a.id === 'owner' && a.deny?.includes(PermissionFlagsBits.SendMessages)));
});

test('erro de permissão ao ler uma mensagem não é tratado como exclusão e não cria entrega duplicada', async t => {
  const f = discordTransport(t); await f.sync(); f.denyRead();
  await assert.rejects(f.sync(), error => error instanceof DiscordAPIError && error.code === 50013);
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().sends, 1);
});
