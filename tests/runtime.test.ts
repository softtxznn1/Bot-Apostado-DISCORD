import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, DiscordAPIError, PermissionFlagsBits, type Client, type EmbedBuilder, type APIEmbed } from 'discord.js';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { BotRuntime } from '../src/bot/runtime.js';
import { loadConfig } from '../src/config.js';

type Payload = { embeds: EmbedBuilder[] };
class FakeMessage {
  readonly id = 'message';
  readonly author = { id: 'bot' };
  embeds: APIEmbed[] = [];
  onEdit: (() => void) | undefined;
  async edit(payload: Payload) {
    this.embeds = payload.embeds.map(e => e.toJSON());
    this.onEdit?.(); return this;
  }
}
function setup(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new BotService(store);
  const admin = { userId: 'admin', moderator: true, mediator: false };
  service.configure({ guildId: 'guild', categoryId: 'category', staffRoleId: 'staff', mediatorRoleId: 'mediators' }, admin);
  const q = service.createQueue('guild', admin, 1, 'mobile', 'Teste de entrega de mensagens.');
  service.joinQueue('guild', q.id, 'p1');
  const m = service.joinQueue('guild', q.id, 'p2').match!;
  const message = new FakeMessage();
  let channelExists = false; let messageExists = false; let creates = 0;
  let mediatorHasRole = true;
  let access: { id: string; deny?: bigint[]; allow?: bigint[] }[] = [];
  const channel = {
    id: 'channel', type: ChannelType.GuildText, topic: `ff-match:${m.id}`,
    permissionOverwrites: { async set(overwrites: typeof access) { access = overwrites; } },
    messages: { async fetch(value: string | { limit?: number; message?: string }) {
      if (typeof value === 'string' || value.message) {
        if (!messageExists) throw new DiscordAPIError({ message: 'Unknown Message', code: 10008 }, 10008, 404, 'GET', '/', {});
        return message;
      }
      return new Collection(messageExists ? [[message.id, message]] : []);
    } },
    async send(payload: Payload) {
      assert.ok(access.some(a => a.id === 'guild' && a.deny?.includes(PermissionFlagsBits.ViewChannel)), 'Publicação precisa ocorrer depois de restringir o canal.');
      messageExists = true; await message.edit(payload); return message;
    },
  };
  const guild = {
    id: 'guild',
    members: { async fetch() { return { id: 'mediator', roles: { cache: new Collection(mediatorHasRole ? [['mediators', {}]] : []) }, permissions: { has: () => false } }; } },
    channels: {
      async fetch(id?: string) {
        if (id && !channelExists) throw new DiscordAPIError({ message: 'Unknown Channel', code: 10003 }, 10003, 404, 'GET', '/', {});
        return id ? channel : new Collection(channelExists ? [[channel.id, channel]] : []);
      },
      async create() { creates++; channelExists = true; return channel; },
    },
  };
  const client = { user: { id: 'bot' }, guilds: { async fetch() { return guild; } } } as unknown as Client;
  const runtime = () => new BotRuntime(client, service, loadConfig({}));
  return { service, m, message, runtime, access: () => access, creates: () => creates,
    deleteMessage: () => { messageExists = false; }, deleteChannel: () => { channelExists = false; messageExists = false; }, revokeMediator: () => { mediatorHasRole = false; } };
}

test('canal é restrito antes de publicar e a entrega é recuperada sem duplicação', async t => {
  const f = setup(t); await f.runtime().syncMatch(f.m.id, 'guild');
  assert.equal(f.creates(), 1);
  assert.ok(f.access().some(a => a.id === 'p1' && a.allow?.includes(PermissionFlagsBits.ViewChannel)));
  assert.ok(f.access().some(a => a.id === 'p2' && a.allow?.includes(PermissionFlagsBits.ViewChannel)));
  assert.ok(!f.access().some(a => a.id === 'mediators' || a.id === 'outsider'));
  assert.equal(f.service.match('guild', f.m.id).messageId, 'message');
  await f.runtime().syncMatch(f.m.id, 'guild');
  assert.equal(f.creates(), 1);
});

test('mudança durante o envio não deixa a mensagem permanentemente desatualizada', async t => {
  const f = setup(t); const runtime = f.runtime();
  await runtime.syncMatch(f.m.id, 'guild');
  f.service.confirm('guild', f.m.id, 'p1');
  f.message.onEdit = () => { f.message.onEdit = undefined; f.service.confirm('guild', f.m.id, 'p2'); };
  await runtime.syncMatch(f.m.id, 'guild');
  assert.equal(f.service.match('guild', f.m.id).state, 'awaiting_mediator');
  await runtime.syncMatch(f.m.id, 'guild');
  assert.ok(f.message.embeds[0]?.title?.includes('Aguardando mediador'));
});

test('cache não impede recuperação de mensagem ou canal excluído sem mudança da partida', async t => {
  const f = setup(t); const runtime = f.runtime(); await runtime.syncMatch(f.m.id, 'guild');
  f.deleteMessage(); await runtime.syncMatch(f.m.id, 'guild');
  assert.equal(f.service.match('guild', f.m.id).messageId, 'message');
  f.deleteChannel(); await runtime.syncMatch(f.m.id, 'guild');
  assert.equal(f.creates(), 2);
});

test('cargo removido revoga leitura e overwrite do mediador atribuído', async t => {
  const f = setup(t); const runtime = f.runtime();
  f.service.confirm('guild', f.m.id, 'p1'); f.service.confirm('guild', f.m.id, 'p2');
  f.service.claim('guild', f.m.id, { userId: 'mediator', moderator: false, mediator: true });
  await runtime.syncMatch(f.m.id, 'guild');
  assert.ok(f.access().some(a => a.id === 'mediator'));
  f.revokeMediator(); await runtime.syncMatch(f.m.id, 'guild');
  assert.ok(!f.access().some(a => a.id === 'mediator'));
  assert.throws(() => f.service.viewMatch('guild', f.m.id, { userId: 'mediator', moderator: false, mediator: false }));
});
