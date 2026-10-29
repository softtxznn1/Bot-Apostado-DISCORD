import {
  ChannelType, Client, DiscordAPIError, EmbedBuilder, Events, OverwriteType, PermissionFlagsBits,
  type Guild, type TextChannel,
} from 'discord.js';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../database.js';
import { DomainError, requireCondition } from '../domain.js';
import { DurableOutbox, type JsonValue } from '../outbox.js';
import { reportError } from '../config.js';
import { ManagedRoomsService } from './service.js';
import { RoomInteractions } from './interactions.js';
import { roomControls, roomEmbed, roomNoMentions, roomPanel } from './presentation.js';
import type { ManagedRoom, RoomSettings } from './types.js';

const terminal = new Set(['closed', 'cancelled', 'expired', 'failed']);
const activeDeliveryCheckMs = 15_000;
const panelDeliveryCheckMs = 60_000;
const archivedDeliveryCheckMs = 5 * 60_000;
const archivedDeliveryBatchSize = 10;
const reconciliationBatchSize = 10;
const reconciliationConcurrency = 3;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function missing(error: unknown, code: number): null {
  if (error instanceof DiscordAPIError && error.code === code) return null;
  throw error;
}

/** Only room commands and room delivery are registered here; no betting modules. */
export class ManagedRoomsRuntime {
  private readonly outbox: DurableOutbox;
  private readonly interactions: RoomInteractions;
  private readonly owner = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly rendered = new Map<string, string>();
  private readonly refreshed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private sweeping = false;
  private reconciling = false;
  private readonly listener: (interaction: Parameters<RoomInteractions['handle']>[0]) => void;

  constructor(private readonly client: Client, private readonly service: ManagedRoomsService, private readonly store: Store) {
    this.outbox = new DurableOutbox(store);
    store.migrateFeature('managed_room_delivery', 1, `
      CREATE TABLE managed_room_panel_delivery (
        guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL
      );
    `);
    this.interactions = new RoomInteractions(service, {
      publish: room => this.publish(room), publishPanel: guildId => this.publishPanel(guildId),
    });
    this.listener = interaction => {
      if (this.stopping || !interaction.inCachedGuild()) return;
      if (interaction.isChatInputCommand() || interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        this.track(this.interactions.handle(interaction));
      }
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.client.on(Events.InteractionCreate, this.listener);
    this.timer = setInterval(() => this.track(this.sweepOnce()), 15_000);
    this.track(this.sweepOnce());
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.client.off(Events.InteractionCreate, this.listener);
    await Promise.allSettled([...this.tasks]);
  }
  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.catch(error => reportError(error, 'managed_rooms_background')).finally(() => this.tasks.delete(task));
  }
  private async locked(key: string, work: () => Promise<void>): Promise<void> {
    const prior = this.locks.get(key);
    if (prior) {
      await prior;
      return this.locked(key, work);
    }
    const task = work(); this.locks.set(key, task);
    try { await task; } finally { this.locks.delete(key); }
  }
  private settings(guildId: string): RoomSettings {
    const settings = this.service.settings(guildId);
    requireCondition(settings, 'ROOMS_NOT_CONFIGURED', 'Configure os canais e cargos das salas antes de publicar.');
    return settings;
  }
  private accessVersion(settings: RoomSettings): string {
    return hash([settings.outputChannelId, settings.operatorRoleIds, settings.managerRoleIds, settings.viewerRoleIds]);
  }
  private panelVersion(settings: RoomSettings): string {
    const { panelMessageId: _message, ...configuration } = settings;
    return hash(configuration);
  }
  private publicationVersion(room: ManagedRoom, settings: RoomSettings): string {
    const { publicationChannelId: _channel, publicationMessageId: _message, ...content } = room;
    return hash([content, this.panelVersion(settings)]);
  }
  private async guild(guildId: string): Promise<Guild> {
    const guild = await this.client.guilds.fetch(guildId);
    requireCondition(guild.id === guildId, 'ROOM_GUILD_MISMATCH', 'Servidor de publicação incompatível.');
    return guild;
  }
  private async channel(guild: Guild, id: string): Promise<TextChannel> {
    const channel = await guild.channels.fetch(id, { force: true }).catch(error => missing(error, 10003));
    requireCondition(channel && channel.guildId === guild.id && channel.type === ChannelType.GuildText,
      'ROOM_CHANNEL_UNAVAILABLE', 'O canal de texto configurado não está disponível neste servidor.');
    return channel;
  }
  private async canSend(guild: Guild, channel: TextChannel): Promise<void> {
    const bot = await guild.members.fetchMe();
    requireCondition(channel.permissionsFor(bot)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
    ]), 'ROOM_BOT_PERMISSIONS', 'O bot precisa visualizar, enviar embeds e ler o histórico do canal configurado.');
  }

  /** Existing channel permissions are inspected, never silently replaced. */
  private async validateSensitiveAccess(guild: Guild, channel: TextChannel, settings: RoomSettings, creatorId: string): Promise<boolean> {
    await this.canSend(guild, channel);
    const roles = await guild.roles.fetch();
    const everyone = roles.get(guild.id) ?? guild.roles.everyone;
    const everyonePermissions = channel.permissionsFor(everyone);
    requireCondition(everyonePermissions && !everyonePermissions.has(PermissionFlagsBits.ViewChannel),
      'ROOM_PUBLIC_CHANNEL', 'O canal de salas permite acesso a @everyone. Restrinja a visualização aos cargos configurados antes de publicar senhas.');
    const allowedRoles = new Set([...settings.operatorRoleIds, ...settings.managerRoleIds, ...settings.viewerRoleIds]);
    // A shared operator role includes creators of other rooms, so it is read-only here.
    const sensitiveRoles = new Set(settings.managerRoleIds);
    let canPublishSecrets = true;
    for (const role of roles.values()) {
      if (role.id === guild.id || role.tags?.botId === this.client.user!.id
        || role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
      const permissions = channel.permissionsFor(role);
      if (allowedRoles.has(role.id)) {
        requireCondition(permissions, 'ROOM_ACCESS_UNKNOWN', 'Não foi possível verificar o acesso de um cargo configurado.');
        if (permissions.has(PermissionFlagsBits.ViewChannel) && !sensitiveRoles.has(role.id)) canPublishSecrets = false;
        continue;
      }
      requireCondition(permissions && !permissions.has(PermissionFlagsBits.ViewChannel), 'ROOM_UNAUTHORIZED_ROLE',
        'Um cargo não autorizado pode visualizar o canal de salas. Revise as permissões ou os cargos de visualização configurados.');
    }
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== OverwriteType.Member || !overwrite.allow.has(PermissionFlagsBits.ViewChannel) || overwrite.id === this.client.user!.id) continue;
      const member = await guild.members.fetch({ user: overwrite.id, force: true }).catch(error => missing(error, 10007));
      const allowed = member && (member.permissions.has(PermissionFlagsBits.ManageGuild)
        || member.permissions.has(PermissionFlagsBits.Administrator)
        || [...allowedRoles].some(id => member.roles.cache.has(id)));
      requireCondition(allowed, 'ROOM_UNAUTHORIZED_MEMBER', 'Uma permissão individual permite acesso não autorizado ao canal de salas. Revise o canal antes de publicar dados de entrada.');
      const sensitive = member && (member.permissions.has(PermissionFlagsBits.ManageGuild)
        || member.permissions.has(PermissionFlagsBits.Administrator)
        || [...sensitiveRoles].some(id => member.roles.cache.has(id))
        || (member.id === creatorId && settings.operatorRoleIds.some(id => member.roles.cache.has(id))));
      if (!sensitive) canPublishSecrets = false;
    }
    return canPublishSecrets;
  }

  private async redact(channel: TextChannel, messageId: string | null, title: string): Promise<void> {
    if (!messageId) return;
    const message = await channel.messages.fetch({ message: messageId, force: true }).catch(error => missing(error, 10008));
    if (!message) return;
    requireCondition(message.author.id === this.client.user!.id, 'ROOM_MESSAGE_AUTHOR', 'A publicação não pertence a este bot.');
    await message.edit({ embeds: [new EmbedBuilder().setTitle(title).setDescription('Dados de entrada removidos. A equipe deve revisar o destino e as permissões configuradas.')], components: [], allowedMentions: roomNoMentions });
  }
  private async configurationChangedAfterSend(guildId: string, channel: TextChannel, messageId: string, cacheKey: string): Promise<never> {
    this.rendered.delete(cacheKey);
    try { await this.redact(channel, messageId, 'Configuração da publicação alterada'); }
    catch (error) {
      // Remember only destination metadata if immediate cleanup is forbidden or unavailable.
      this.outbox.enqueue(`managed-redact:${hash([guildId, channel.id, messageId])}`, 'managed_room_redact', {
        guildId, channelId: channel.id, messageId, cacheKey,
      });
      reportError(error, 'managed_room_cleanup');
    }
    throw new DomainError('ROOM_SETTINGS_CHANGED', 'A configuração mudou durante o envio. A publicação anterior foi marcada para remoção dos dados; a entrega será refeita no destino atual.');
  }

  async publish(room: ManagedRoom): Promise<void> {
    await this.locked(`room:${room.id}`, () => this.publishCurrent(room.guildId, room.id));
  }
  private async publishCurrent(guildId: string, id: string): Promise<void> {
    let room = this.service.getForDelivery(guildId, id);
    if (!room.confirmed || room.state === 'draft' || room.state === 'creating' || room.state === 'failed') return;
    const settings = this.settings(guildId); const guild = await this.guild(guildId);
    if (room.publicationChannelId && room.publicationChannelId !== settings.outputChannelId) {
      const previous = await guild.channels.fetch(room.publicationChannelId, { force: true }).catch(error => missing(error, 10003));
      if (previous?.type === ChannelType.GuildText) await this.redact(previous, room.publicationMessageId, 'Publicação de sala movida');
    }
    const channel = await this.channel(guild, settings.outputChannelId);
    let canPublishSecrets: boolean;
    try { canPublishSecrets = await this.validateSensitiveAccess(guild, channel, settings, room.creatorId); }
    catch (error) {
      if (room.publicationChannelId === channel.id) {
        try { await this.redact(channel, room.publicationMessageId, 'Acesso à sala precisa de revisão'); }
        catch (redactionError) { reportError(redactionError, 'room_redaction'); }
      }
      this.rendered.delete(`room:${id}`); throw error;
    }
    room = this.service.getForDelivery(guildId, id);
    let message = room.publicationChannelId === channel.id && room.publicationMessageId
      ? await channel.messages.fetch({ message: room.publicationMessageId, force: true }).catch(error => missing(error, 10008)) : null;
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 30 });
      message = recent.find(m => m.author.id === this.client.user!.id && m.embeds.some(e => e.footer?.text === `ROOM:${id}`)) ?? null;
    }
    requireCondition(this.accessVersion(this.settings(guildId)) === this.accessVersion(settings),
      'ROOM_SETTINGS_CHANGED', 'O destino ou os cargos das salas mudaram durante a publicação. A entrega será refeita com a configuração atual.');
    room = this.service.getForDelivery(guildId, id);
    const fingerprint = hash([room, settings, canPublishSecrets]);
    const payload = { embeds: [roomEmbed(room, canPublishSecrets && !terminal.has(room.state))], components: roomControls(room), allowedMentions: roomNoMentions };
    if (message) {
      requireCondition(message.author.id === this.client.user!.id, 'ROOM_MESSAGE_AUTHOR', 'A publicação não pertence a este bot.');
      if (this.rendered.get(`room:${id}`) !== fingerprint) await message.edit(payload);
    } else message = await channel.send({ ...payload, nonce: hash([guildId, id, channel.id, room.publicationMessageId]).slice(0, 24), enforceNonce: true });
    if (this.accessVersion(this.settings(guildId)) !== this.accessVersion(settings)) {
      return this.configurationChangedAfterSend(guildId, channel, message.id, `room:${id}`);
    }
    this.service.attachPublication(guildId, id, channel.id, message.id);
    this.rendered.set(`room:${id}`, hash([{ ...room, publicationChannelId: channel.id, publicationMessageId: message.id }, settings, canPublishSecrets]));
    this.scheduleAudit(room, settings);
  }

  async publishPanel(guildId: string): Promise<void> {
    await this.locked(`panel:${guildId}`, async () => {
      const settings = this.settings(guildId); const guild = await this.guild(guildId);
      const previous = this.store.db.prepare('SELECT channel_id,message_id FROM managed_room_panel_delivery WHERE guild_id=?').get(guildId) as { channel_id: string; message_id: string } | undefined;
      if (previous && previous.channel_id !== settings.panelChannelId) {
        const oldChannel = await guild.channels.fetch(previous.channel_id, { force: true }).catch(error => missing(error, 10003));
        if (oldChannel?.type === ChannelType.GuildText) await this.redact(oldChannel, previous.message_id, 'Painel de salas movido');
      }
      const channel = await this.channel(guild, settings.panelChannelId); await this.canSend(guild, channel);
      let message = settings.panelMessageId ? await channel.messages.fetch({ message: settings.panelMessageId, force: true }).catch(error => missing(error, 10008)) : null;
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 30 });
        message = recent.find(m => m.author.id === this.client.user!.id && m.embeds.some(e => e.footer?.text === `ROOM_PANEL:${guildId}`)) ?? null;
      }
      requireCondition(this.settings(guildId).panelChannelId === channel.id,
        'ROOM_SETTINGS_CHANGED', 'O canal do painel mudou durante a publicação. A entrega será refeita no destino atual.');
      const payload = roomPanel(guildId); const fingerprint = hash(payload);
      if (message) {
        requireCondition(message.author.id === this.client.user!.id, 'ROOM_MESSAGE_AUTHOR', 'A mensagem de painel não pertence a este bot.');
        if (this.rendered.get(`panel:${guildId}`) !== fingerprint) await message.edit(payload);
      } else message = await channel.send({ ...payload, nonce: hash([guildId, channel.id, settings.panelMessageId]).slice(0, 24), enforceNonce: true });
      if (this.settings(guildId).panelChannelId !== channel.id) {
        return this.configurationChangedAfterSend(guildId, channel, message.id, `panel:${guildId}`);
      }
      this.service.updatePanel(guildId, channel.id, message.id);
      this.store.db.prepare(`INSERT INTO managed_room_panel_delivery(guild_id,channel_id,message_id) VALUES(?,?,?)
        ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id`).run(guildId, channel.id, message.id);
      this.rendered.set(`panel:${guildId}`, fingerprint);
    });
  }

  private deliveryCheck(key: string, version: string, intervalMs: number): { due: boolean; checkedAt: number } {
    const prior = this.outbox.get(key);
    const old = prior?.payload && typeof prior.payload === 'object' && !Array.isArray(prior.payload) ? prior.payload : undefined;
    const checkedAt = typeof old?.checkedAt === 'number' ? old.checkedAt : 0;
    if (prior && old?.version === version) {
      if (prior.state !== 'done' || Date.now() - checkedAt < intervalMs) return { due: false, checkedAt };
    }
    return { due: true, checkedAt };
  }
  private schedule(key: string, type: string, payload: Record<string, JsonValue>, version: string, intervalMs: number): void {
    if (!this.deliveryCheck(key, version, intervalMs).due) return;
    this.outbox.enqueue(key, type, { ...payload, version, checkedAt: Date.now() });
  }
  private scheduleAudit(room: ManagedRoom, settings: RoomSettings): void {
    if (!settings.logChannelId) return;
    const version = hash([room.id, room.state, room.pending?.id ?? null, room.confirmed?.state,
      room.confirmed?.modeId, room.confirmed?.mapId, room.confirmed?.maxPlayers]);
    this.outbox.enqueue(`managed-audit:${room.id}:${version}`, 'managed_room_audit', {
      guildId: room.guildId, id: room.id, state: room.state, creatorId: room.creatorId, marker: version,
    });
  }
  private async audit(guildId: string, id: string, state: string, creatorId: string, marker: string): Promise<void> {
    const settings = this.settings(guildId); if (!settings.logChannelId) return;
    const guild = await this.guild(guildId); const channel = await this.channel(guild, settings.logChannelId);
    await this.canSend(guild, channel);
    const footer = `ROOM_LOG:${id}:${marker}`;
    const recent = await channel.messages.fetch({ limit: 30 });
    if (recent.some(m => m.author.id === this.client.user!.id && m.embeds.some(e => e.footer?.text === footer))) return;
    await channel.send({ embeds: [new EmbedBuilder().setTitle('Atualização de sala').addFields(
      { name: 'Referência interna', value: id }, { name: 'Estado', value: state },
      { name: 'Criador', value: `<@${creatorId}>` },
    ).setFooter({ text: footer })], allowedMentions: roomNoMentions });
  }

  private reconcileInBackground(all: ManagedRoom[]): void {
    if (this.reconciling || this.stopping) return;
    const eligible = all.filter(room => this.client.guilds.cache.has(room.guildId) && room.state !== 'draft' && !terminal.has(room.state)
      && Date.now() - (this.refreshed.get(room.id) ?? 0) >= 30_000);
    // A lookup that is still unknown need not change updated_at. Always give
    // rooms with the oldest read a turn, including those beyond the first batch.
    eligible.sort((a, b) => (this.refreshed.get(a.id) ?? 0) - (this.refreshed.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    const queue = eligible.slice(0, reconciliationBatchSize);
    if (!queue.length) return;
    this.reconciling = true;
    const worker = async () => {
      while (!this.stopping) {
        const room = queue.shift(); if (!room) return;
        this.refreshed.set(room.id, Date.now());
        try {
          const current = await this.service.synchronizeForDelivery(room.guildId, room.id);
          if (!this.stopping && current.confirmed && this.client.guilds.cache.has(current.guildId)) {
            const version = this.publicationVersion(current, this.settings(current.guildId));
            this.schedule(`managed-publish:${current.id}`, 'managed_room_publish', { guildId: current.guildId, id: current.id }, version,
              terminal.has(current.state) ? archivedDeliveryCheckMs : activeDeliveryCheckMs);
          }
        } catch (error) { reportError(error, 'managed_room_sync'); }
      }
    };
    // Remote reads must not delay publication and permission checks. There is
    // only one batch and at most three reads in flight, all awaited by stop().
    const task = Promise.all(Array.from({ length: Math.min(reconciliationConcurrency, queue.length) }, worker))
      .then(() => undefined).finally(() => { this.reconciling = false; });
    this.track(task);
  }

  async sweepOnce(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      const all = this.service.listForReconciliation();
      this.reconcileInBackground(all);
      const archived: { room: ManagedRoom; version: string; checkedAt: number }[] = [];
      for (const room of this.service.listForReconciliation()) if (this.client.guilds.cache.has(room.guildId) && room.confirmed) {
        const version = this.publicationVersion(room, this.settings(room.guildId));
        if (!terminal.has(room.state)) {
          this.schedule(`managed-publish:${room.id}`, 'managed_room_publish', { guildId: room.guildId, id: room.id }, version, activeDeliveryCheckMs);
        } else {
          const check = this.deliveryCheck(`managed-publish:${room.id}`, version, archivedDeliveryCheckMs);
          if (check.due) archived.push({ room, version, checkedAt: check.checkedAt });
        }
      }
      for (const settings of this.service.listSettings()) if (this.client.guilds.cache.has(settings.guildId)) {
        this.schedule(`managed-panel:${settings.guildId}`, 'managed_room_panel', { guildId: settings.guildId }, this.panelVersion(settings), panelDeliveryCheckMs);
      }
      // Check the oldest archive destinations in bounded batches. Active room
      // updates and panels enter the queue before historical maintenance.
      archived.sort((a, b) => a.checkedAt - b.checkedAt || a.room.id.localeCompare(b.room.id));
      for (const { room, version } of archived.slice(0, archivedDeliveryBatchSize)) {
        this.schedule(`managed-publish:${room.id}`, 'managed_room_publish', { guildId: room.guildId, id: room.id }, version, archivedDeliveryCheckMs);
      }
      for (let count = 0; count < 30 && !this.stopping; count++) {
        const job = this.outbox.claim(this.owner, 120_000, ['managed_room_publish', 'managed_room_panel', 'managed_room_audit', 'managed_room_redact']); if (!job) break;
        try {
          requireCondition(job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload), 'ROOM_JOB_INVALID', 'Referência da publicação inválida.');
          const { guildId, id } = job.payload;
          requireCondition(typeof guildId === 'string' && this.client.guilds.cache.has(guildId), 'ROOM_JOB_INVALID', 'Servidor de publicação indisponível.');
          if (job.type === 'managed_room_redact') {
            const { channelId, messageId, cacheKey } = job.payload;
            requireCondition(typeof channelId === 'string' && typeof messageId === 'string' && typeof cacheKey === 'string', 'ROOM_JOB_INVALID', 'Destino da remoção inválido.');
            const guild = await this.guild(guildId);
            const channel = await guild.channels.fetch(channelId, { force: true }).catch(error => missing(error, 10003));
            if (channel?.type === ChannelType.GuildText) await this.redact(channel, messageId, 'Configuração da publicação alterada');
            this.rendered.delete(cacheKey);
          } else if (job.type === 'managed_room_panel') await this.publishPanel(guildId);
          else {
            requireCondition(typeof id === 'string', 'ROOM_JOB_INVALID', 'Sala da publicação não encontrada.');
            if (job.type === 'managed_room_publish') await this.publish(this.service.getForDelivery(guildId, id));
            else if (job.type === 'managed_room_audit') {
              const { state, creatorId, marker } = job.payload;
              requireCondition(typeof state === 'string' && typeof creatorId === 'string' && typeof marker === 'string', 'ROOM_JOB_INVALID', 'Evento de publicação inválido.');
              await this.audit(guildId, id, state, creatorId, marker);
            } else throw new DomainError('ROOM_JOB_INVALID', 'Tipo de publicação desconhecido.');
          }
          this.outbox.complete(this.owner, job);
        } catch (error) {
          this.outbox.fail(this.owner, job, error instanceof DomainError ? error.code : 'ROOM_DELIVERY_FAILED');
          reportError(error, 'managed_room_delivery');
        }
      }
    } finally { this.sweeping = false; }
  }
}
