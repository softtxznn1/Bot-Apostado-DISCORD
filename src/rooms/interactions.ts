import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type Interaction, type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { DomainError, requireCondition } from '../domain.js';
import { reportError } from '../config.js';
import { ManagedRoomsService } from './service.js';
import { RoomDeliveryOperations } from './operations.js';
import { validateOptions } from './validation.js';
import type { ManagedRoom, ManagedRoomState, RoomActor, RoomCatalog, RoomMode, RoomOptionField, RoomOptions, RoomSettings } from './types.js';
import { roomControls, roomEmbed, roomNoMentions, roomStateLabels } from './presentation.js';

type CachedInteraction = ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;
type MessageInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>;
type Wizard = {
  id: string; guildId: string; userId: string; expiresAt: number; version: number;
  kind: 'create' | 'update' | 'draft'; roomId?: string; catalog: RoomCatalog;
  options: RoomOptions; originalMode?: RoomMode;
  stage: 'mode' | 'map' | 'details' | 'extra' | 'preview' | 'executing';
  extraIndex: number;
};
export type RoomInteractionCallbacks = {
  publish(room: ManagedRoom): Promise<void>;
  publishPanel(guildId: string): Promise<void>;
};
type Payload = {
  content?: string; embeds?: EmbedBuilder[];
  components?: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
};
const button = (id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label.slice(0, 80)).setStyle(style);
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
const integer = (value: string, label: string): number => {
  requireCondition(/^\d{1,6}$/.test(value), 'INVALID_ROOM_INPUT', `${label}: informe um número inteiro válido.`);
  return Number(value);
};
const csv = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);

export class RoomInteractions {
  private readonly sessions = new Map<string, Wizard>();
  private readonly freshActors = new WeakMap<object, RoomActor>();
  private readonly operations: RoomDeliveryOperations;
  constructor(private readonly service: ManagedRoomsService, private readonly callbacks: RoomInteractionCallbacks, private readonly now = Date.now) {
    this.operations = new RoomDeliveryOperations(service, now);
  }

  private actor(i: CachedInteraction): RoomActor {
    return this.freshActors.get(i) ?? { userId: i.user.id, roleIds: [...i.member.roles.cache.keys()], administrator: i.memberPermissions.has(PermissionFlagsBits.ManageGuild) };
  }
  private async refreshActor(i: CachedInteraction): Promise<RoomActor> {
    const member = await i.guild.members.fetch({ user: i.user.id, force: true });
    const actor = { userId: i.user.id, roleIds: [...member.roles.cache.keys()], administrator: member.permissions.has(PermissionFlagsBits.ManageGuild) };
    this.freshActors.set(i, actor); return actor;
  }
  private prune(): void {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }
  private settings(guild: string): RoomSettings {
    const cfg = this.service.settings(guild);
    requireCondition(cfg, 'ROOMS_NOT_CONFIGURED', 'Use /salas configurar antes de abrir o painel.'); return cfg;
  }
  private canOperate(guild: string, actor: RoomActor): boolean {
    const cfg = this.settings(guild);
    return actor.administrator || [...cfg.operatorRoleIds, ...cfg.managerRoleIds].some(id => actor.roleIds.includes(id));
  }
  private session(i: CachedInteraction, id: string, version: string): Wizard {
    const session = this.sessions.get(id);
    requireCondition(session && session.expiresAt > this.now(), 'ROOM_SESSION_EXPIRED', 'Este assistente expirou. Abra novamente Criar sala ou Editar. Seus registros já salvos continuam no histórico.');
    requireCondition(session.guildId === i.guildId && session.userId === i.user.id, 'FORBIDDEN', 'Este assistente pertence a outra pessoa ou servidor.');
    requireCondition(String(session.version) === version, 'ROOM_SESSION_OLD', 'Este controle já foi substituído. Use a mensagem mais recente do assistente.');
    requireCondition(this.canOperate(i.guildId, this.actor(i)), 'FORBIDDEN', 'Seu cargo atual não permite gerenciar salas.');
    if (session.kind !== 'create' && session.roomId) this.service.get(i.guildId, session.roomId, this.actor(i));
    return session;
  }
  private control(s: Wizard, action: string, page?: number): string {
    return `room:w:${s.id}:${s.version}:${action}${page === undefined ? '' : `:${page}`}`;
  }
  private mode(s: Wizard): RoomMode {
    const mode = s.catalog.modes.find(m => m.id === s.options.modeId);
    requireCondition(mode, 'INVALID_ROOM_MODE', 'Selecione um modo disponível.'); return mode;
  }
  private editable(s: Wizard, field: RoomMode['editableFields'][number]): boolean {
    return s.kind === 'create' || s.kind === 'draft' || !!s.originalMode?.editableFields.includes(field);
  }
  private extras(s: Wizard): RoomOptionField[] {
    return this.mode(s).optionFields.filter(f => s.kind !== 'update' || s.options.modeId !== s.originalMode?.id || f.editable === true);
  }
  private baseFields(s: Wizard): ('name' | 'maxPlayers' | 'password')[] {
    return (['name', 'maxPlayers', 'password'] as const).filter(f => this.editable(s, f));
  }
  private firstStage(s: Wizard): Wizard['stage'] {
    if (this.editable(s, 'modeId')) return 'mode';
    if (this.editable(s, 'mapId')) return 'map';
    return this.baseFields(s).length ? 'details' : 'extra';
  }
  private selection(s: Wizard, action: string, values: { value: string; label: string }[], page: number, placeholder: string, current?: string): Payload {
    requireCondition(values.length, 'ROOM_CATALOG_EMPTY', 'O catálogo não contém opções disponíveis para esta configuração.');
    const pages = Math.ceil(values.length / 25);
    requireCondition(Number.isInteger(page) && page >= 0 && page < pages, 'ROOM_PAGE', 'Página de opções inválida.');
    const menu = new StringSelectMenuBuilder().setCustomId(this.control(s, action, page)).setPlaceholder(placeholder.slice(0, 150)).setMinValues(1).setMaxValues(1)
      .addOptions(values.slice(page * 25, (page + 1) * 25).map(v => new StringSelectMenuOptionBuilder().setLabel(v.label.slice(0, 100)).setValue(v.value).setDefault(v.value === current)));
    const navigation: ButtonBuilder[] = [];
    if (page) navigation.push(button(this.control(s, `${action}-page`, page - 1), 'Anterior'));
    if (page + 1 < pages) navigation.push(button(this.control(s, `${action}-page`, page + 1), 'Próxima'));
    navigation.push(button(this.control(s, 'abort'), 'Sair do assistente', ButtonStyle.Danger));
    return { content: `${placeholder} • página ${page + 1}/${pages}`, embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), row(...navigation)] };
  }
  private render(s: Wizard, page = 0): Payload {
    if (s.stage === 'mode') return this.selection(s, 'mode', s.catalog.modes.map(m => ({ value: m.id, label: m.label })), page, 'Escolha o modo', s.options.modeId);
    if (s.stage === 'map') {
      const mode = this.mode(s);
      return this.selection(s, 'map', s.catalog.maps.filter(m => mode.mapIds.includes(m.id)).map(m => ({ value: m.id, label: m.label })), page, 'Escolha o mapa', s.options.mapId);
    }
    if (s.stage === 'details') return { content: 'Preencha os dados da sala. Somente campos editáveis são apresentados.', embeds: [], components: [row(button(this.control(s, 'details'), 'Preencher dados', ButtonStyle.Primary), button(this.control(s, 'abort'), 'Sair', ButtonStyle.Danger))] };
    if (s.stage === 'extra') {
      const field = this.extras(s)[s.extraIndex];
      requireCondition(field, 'ROOM_SESSION_STATE', 'Opção do assistente inválida.');
      if (field.type === 'boolean' || field.type === 'choice') {
        const values = field.type === 'boolean' ? [{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não' }] : field.choices!;
        const payload = this.selection(s, 'extra', values, page, field.label, String(s.options.extras[field.id] ?? ''));
        if (!field.required) payload.components!.push(row(button(this.control(s, 'skip'), s.options.extras[field.id] === undefined ? 'Usar padrão do provedor' : 'Manter valor atual')));
        return payload;
      }
      return { content: `${field.label}${field.required ? ' • obrigatório' : ' • opcional'}`, embeds: [], components: [row(
        button(this.control(s, 'extra-input'), 'Preencher opção', ButtonStyle.Primary),
        ...(!field.required ? [button(this.control(s, 'skip'), s.options.extras[field.id] === undefined ? 'Usar padrão do provedor' : 'Manter valor atual')] : []),
        button(this.control(s, 'abort'), 'Sair', ButtonStyle.Danger),
      )] };
    }
    requireCondition(s.stage === 'preview', 'ROOM_SESSION_STATE', 'Este assistente está processando uma operação.');
    const cfg = this.settings(s.guildId); const mode = this.mode(s);
    const map = s.catalog.maps.find(m => m.id === s.options.mapId);
    const embed = new EmbedBuilder().setTitle(s.kind === 'update' ? 'Confirmar alteração da sala' : 'Confirmar criação da sala').setColor(0x5865f2)
      .addFields({ name: 'Nome', value: s.options.name }, { name: 'Modo', value: mode.label, inline: true },
        { name: 'Mapa', value: map?.label ?? s.options.mapId, inline: true }, { name: 'Capacidade', value: String(s.options.maxPlayers), inline: true },
        { name: 'Canal de destino', value: `<#${cfg.outputChannelId}>` }, { name: 'Senha', value: s.options.password ? 'Definida • não exibida nesta prévia' : 'Conforme o provedor' });
    const extras = Object.entries(s.options.extras).map(([key, value]) => `${mode.optionFields.find(f => f.id === key)?.label ?? key}: ${String(value)}`).join('\n');
    if (extras) embed.addFields({ name: 'Opções selecionadas', value: extras.slice(0, 1000) });
    return { content: 'Confirme somente depois de conferir as opções e o destino.', embeds: [embed], components: [row(
      button(this.control(s, 'confirm'), s.kind === 'update' ? 'Confirmar alteração' : 'Confirmar e criar sala', ButtonStyle.Success),
      button(this.control(s, 'abort'), s.kind === 'update' ? 'Descartar alteração' : 'Descartar rascunho', ButtonStyle.Danger),
    )] };
  }
  private async preview(s: Wizard, actor: RoomActor): Promise<void> {
    // Refetch options before preview; the final write revalidates again in the service.
    s.catalog = await this.service.catalog(s.guildId, actor);
    s.options = validateOptions(s.options, s.catalog, this.settings(s.guildId));
    if (s.kind === 'create' && !s.roomId) s.roomId = (await this.service.createDraft(s.guildId, actor, s.options)).id;
    s.stage = 'preview';
  }
  private async afterDetails(s: Wizard, actor: RoomActor): Promise<void> {
    s.stage = 'extra'; s.extraIndex = 0;
    if (!this.extras(s).length) await this.preview(s, actor);
  }
  private async advanceExtra(s: Wizard, actor: RoomActor): Promise<void> {
    s.extraIndex++;
    if (s.extraIndex >= this.extras(s).length) await this.preview(s, actor);
  }
  private async begin(i: CachedInteraction, editId?: string): Promise<void> {
    const actor = this.actor(i); requireCondition(this.canOperate(i.guildId, actor), 'FORBIDDEN', 'Seu cargo não permite criar ou editar salas.');
    const catalog = await this.service.catalog(i.guildId, actor);
    requireCondition(catalog.modes.length && catalog.maps.length, 'ROOM_CATALOG_EMPTY', 'Nenhum modo/mapa permitido está disponível.');
    const existing = editId ? this.service.get(i.guildId, editId, actor) : undefined;
    if (existing) requireCondition(!existing.pending && !['cancelled', 'closed', 'expired', 'uncertain', 'failed'].includes(existing.state), 'INVALID_ROOM_STATE', 'Esta sala não pode ser editada neste estado.');
    const originalMode = existing ? catalog.modes.find(m => m.id === existing.options.modeId) : undefined;
    if (existing) requireCondition(originalMode, 'ROOM_CATALOG_CHANGED', 'O modo da sala não está mais disponível; consulte a administração.');
    if (this.sessions.size >= 500) throw new DomainError('ROOM_BUSY', 'Há muitos assistentes abertos. Aguarde a expiração de uma sessão.');
    const s: Wizard = {
      id: randomBytes(8).toString('hex'), guildId: i.guildId, userId: i.user.id,
      expiresAt: this.now() + 600_000, version: 0, kind: existing ? existing.state === 'draft' ? 'draft' : 'update' : 'create',
      roomId: existing?.id, catalog, originalMode,
      options: existing ? { ...existing.options, extras: { ...existing.options.extras } } : { name: '', modeId: '', mapId: '', maxPlayers: 0, extras: {} },
      stage: 'mode', extraIndex: 0,
    };
    s.stage = this.firstStage(s); this.sessions.set(s.id, s);
    if (s.stage === 'extra' && !this.extras(s).length) await this.preview(s, actor);
    await i.editReply({ ...this.render(s), allowedMentions: roomNoMentions });
  }
  private modal(s: Wizard, action: 'details' | 'extra-input'): ModalBuilder {
    const modal = new ModalBuilder().setCustomId(this.control(s, `${action}-submit`)).setTitle(action === 'details' ? 'Dados da sala' : 'Opção da sala');
    if (action === 'details') {
      const labels = { name: 'Nome da sala', maxPlayers: 'Quantidade de jogadores (capacidade)', password: 'Senha (vazio: conforme o provedor)' };
      for (const field of this.baseFields(s)) {
        const value = s.options[field];
        const input = new TextInputBuilder().setCustomId(field).setLabel(labels[field]).setStyle(TextInputStyle.Short).setRequired(field !== 'password').setMaxLength(field === 'name' ? 80 : field === 'password' ? 64 : 6);
        if (value !== undefined && value !== '' && value !== 0) input.setValue(String(value));
        if (field === 'maxPlayers') input.setPlaceholder(`${this.mode(s).minPlayers} a ${this.mode(s).maxPlayers}`);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      }
    } else {
      const field = this.extras(s)[s.extraIndex]; requireCondition(field, 'ROOM_SESSION_STATE', 'Opção inválida.');
      const input = new TextInputBuilder().setCustomId('value').setLabel(field.label.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(!!field.required).setMaxLength(field.type === 'integer' ? 17 : Math.min(field.maxLength ?? 500, 1000));
      if (s.options.extras[field.id] !== undefined) input.setValue(String(s.options.extras[field.id]));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    return modal;
  }
  private async showRoom(i: CachedInteraction, id: string, refresh: boolean): Promise<void> {
    const actor = await this.refreshActor(i);
    let privateAccess = false;
    try { this.service.get(i.guildId, id, actor); privateAccess = true; }
    catch (error) { if (!(error instanceof DomainError && error.code === 'FORBIDDEN')) throw error; }
    if (refresh && privateAccess) {
      const updated = await this.service.synchronize(i.guildId, id, actor);
      if (updated.confirmed) await this.callbacks.publish(updated);
    }
    const currentActor = await this.refreshActor(i);
    try { this.service.get(i.guildId, id, currentActor); privateAccess = true; }
    catch (error) { if (!(error instanceof DomainError && error.code === 'FORBIDDEN')) throw error; privateAccess = false; }
    const room = privateAccess ? this.service.get(i.guildId, id, currentActor) : this.service.getPublic(i.guildId, id, currentActor);
    await i.editReply({ content: privateAccess ? '' : 'Visualização de consulta sem dados privados. Estado salvo na última sincronização.',
      embeds: [roomEmbed(room, privateAccess)], components: privateAccess ? roomControls(room) : [], allowedMentions: roomNoMentions });
  }
  private async list(i: CachedInteraction, mine: boolean, page = 1, state?: ManagedRoomState, creator?: string): Promise<void> {
    const result = this.service.list(i.guildId, this.actor(i), { page, state, creatorId: mine ? i.user.id : creator });
    const embed = new EmbedBuilder().setTitle(mine ? 'Minhas salas' : 'Histórico de salas').setColor(0x5865f2)
      .setDescription(result.items.map(r => `**${r.options.name.replace(/[\n\r]/g, ' ').slice(0, 65)}** • ${roomStateLabels[r.state]}\n\`${r.id}\` • ${r.options.modeId} / ${r.options.mapId} • ${r.options.maxPlayers} jogadores`).join('\n\n').slice(0, 4000) || 'Nenhuma sala corresponde a esta consulta.')
      .setFooter({ text: `Página ${result.page} • ${result.total} registros` });
    const navigation: ButtonBuilder[] = [];
    // Filtered slash-command results are not silently broadened by pagination.
    if (!state && !creator) {
      if (page > 1) navigation.push(button(`room:${mine ? 'mine' : 'list'}:${page - 1}`, 'Anterior'));
      if (page * result.pageSize < result.total) navigation.push(button(`room:${mine ? 'mine' : 'list'}:${page + 1}`, 'Próxima'));
    }
    await i.editReply({ content: '', embeds: [embed], components: navigation.length ? [row(...navigation)] : [], allowedMentions: roomNoMentions });
  }
  private actionModal(id: string, action: 'cancel' | 'close'): ModalBuilder {
    return new ModalBuilder().setCustomId(`room:end:${action}:${id}`).setTitle(action === 'cancel' ? 'Confirmar cancelamento' : 'Confirmar encerramento')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motivo (confirma a ação na sala selecionada)').setStyle(TextInputStyle.Paragraph).setMinLength(3).setMaxLength(300).setRequired(true)));
  }

  async handle(interaction: Interaction): Promise<boolean> {
    if (!interaction.inCachedGuild()) return false;
    if (!(interaction.isChatInputCommand() || interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return false;
    const i = interaction as CachedInteraction;
    if (i.isChatInputCommand() ? !['salas', 'sala'].includes(i.commandName) : !i.customId.startsWith('room:')) return false;
    this.prune();
    try {
      if (i.isChatInputCommand()) { await i.deferReply({ flags: MessageFlags.Ephemeral }); await this.command(i); }
      else if (i.isModalSubmit()) await this.submit(i);
      else await this.component(i);
    } catch (error) {
      reportError(error, 'rooms_interaction');
      let content = error instanceof DomainError ? error.message : 'Não foi possível concluir a operação. Consulte o estado da sala antes de repetir uma ação.';
      let recovery: Payload | undefined;
      if (!i.isChatInputCommand() && i.customId.startsWith('room:w:')) {
        const session = this.sessions.get(i.customId.split(':')[2] ?? '');
        if (session?.stage === 'executing' && session.roomId && session.guildId === i.guildId && session.userId === i.user.id) {
          content += `\nSala: \`${session.roomId}\`. Consulte o estado antes de qualquer nova criação.`;
          this.sessions.delete(session.id);
        } else if (session && session.guildId === i.guildId && session.userId === i.user.id) {
          try {
            requireCondition(this.canOperate(i.guildId, await this.refreshActor(i)), 'FORBIDDEN', 'Seu cargo não permite continuar.');
            if (session.stage === 'extra' && session.extraIndex >= this.extras(session).length) {
              session.stage = this.baseFields(session).length ? 'details' : this.firstStage(session);
              session.extraIndex = 0; session.version++;
            }
            recovery = this.render(session);
            content += '\nCorrija os dados usando os controles abaixo.';
          } catch { recovery = undefined; }
        }
      }
      try {
        if (i.deferred || i.replied) await i.editReply({ ...(recovery ?? {}), content, allowedMentions: roomNoMentions });
        else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: roomNoMentions });
      } catch (replyError) { reportError(replyError, 'rooms_reply'); }
    }
    return true;
  }

  private async command(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const actor = this.actor(i); const o = i.options; const sub = o.getSubcommand();
    if (i.commandName === 'sala') {
      if (sub === 'criar') { await this.begin(i); return; }
      const id = o.getString('id', true);
      if (sub === 'atualizar') { await this.begin(i, id); return; }
      if (sub === 'cancelar' || sub === 'encerrar') {
        this.service.get(i.guildId, id, actor);
        await i.editReply({ content: `Confirme a ação na sala \`${id}\` e informe o motivo.`, components: [row(button(`room:${sub === 'cancelar' ? 'cancel' : 'close'}:${id}`, sub === 'cancelar' ? 'Confirmar cancelamento' : 'Confirmar encerramento', ButtonStyle.Danger))] }); return;
      }
      await this.showRoom(i, id, true); return;
    }
    if (sub === 'diagnostico' || sub === 'reprocessar') {
      // The initial interaction member can be stale after deferReply/network waits.
      const currentActor = await this.refreshActor(i);
      if (sub === 'reprocessar') {
        const task = this.operations.retry(i.guildId, currentActor, o.getString('tarefa', true), o.getString('motivo', true));
        await i.editReply({ content: `Entrega \`${task.reference}\` devolvida à fila. Nenhuma operação de criação ou alteração da sala foi repetida.`, allowedMentions: roomNoMentions });
        return;
      }
      const result = this.operations.diagnose(i.guildId, currentActor, o.getInteger('pagina') ?? 1);
      const states = { pending: 'Aguardando', running: 'Em execução', done: 'Concluída', dead: 'Tentativas esgotadas' };
      const types: Record<string, string> = { managed_room_publish: 'Publicação da sala', managed_room_panel: 'Painel', managed_room_audit: 'Evento de auditoria', managed_room_redact: 'Remoção de dados antigos' };
      const embed = new EmbedBuilder().setTitle('Diagnóstico das entregas de salas').setColor(result.counts.dead ? 0xe6a23c : 0x5865f2)
        .setDescription(result.items.map(task => `\`${task.reference}\`\n${types[task.type]} • ${states[task.state]} • ${task.attempts} tentativa(s)${task.lastError ? ` • ${task.lastError}` : ''}`).join('\n\n') || 'Nenhuma tarefa nesta página.')
        .addFields({ name: 'Fila deste servidor', value: `Aguardando: ${result.counts.pending} • Em execução: ${result.counts.running}\nConcluídas: ${result.counts.done} • Esgotadas: ${result.counts.dead}` })
        .setFooter({ text: `Página ${result.page} • ${result.total} tarefas • /salas reprocessar recupera somente entregas esgotadas` });
      await i.editReply({ embeds: [embed], allowedMentions: roomNoMentions }); return;
    }
    if (sub === 'configurar') {
      requireCondition(actor.administrator, 'FORBIDDEN', 'Somente a administração pode configurar salas.');
      const prior = this.service.settings(i.guildId);
      const selected = (name: string, fallback: string[]) => o.getString(name) === null ? fallback : csv(o.getString(name)!);
      const extraInput = o.getString('extras');
      const cfg: RoomSettings = {
        guildId: i.guildId, panelChannelId: o.getChannel('painel', true).id, outputChannelId: o.getChannel('publicacao', true).id,
        logChannelId: o.getChannel('logs')?.id ?? prior?.logChannelId ?? null,
        operatorRoleIds: [...new Set([o.getRole('operador', true).id, ...(prior?.operatorRoleIds ?? [])])],
        managerRoleIds: [...new Set([...(o.getRole('gerente') ? [o.getRole('gerente')!.id] : []), ...(prior?.managerRoleIds ?? [])])],
        viewerRoleIds: [...new Set([...(o.getRole('visualizador') ? [o.getRole('visualizador')!.id] : []), ...(prior?.viewerRoleIds ?? [])])],
        allowedModeIds: selected('modos', prior?.allowedModeIds ?? []), allowedMapIds: selected('mapas', prior?.allowedMapIds ?? []),
        allowedExtraIds: extraInput === null ? prior?.allowedExtraIds : extraInput.trim() === '*' ? undefined : csv(extraInput),
        maxActivePerUser: o.getInteger('limite_usuario') ?? prior?.maxActivePerUser ?? 3,
        maxActivePerGuild: o.getInteger('limite_servidor') ?? prior?.maxActivePerGuild ?? 30,
        cooldownSeconds: o.getInteger('intervalo') ?? prior?.cooldownSeconds ?? 10,
        panelMessageId: prior?.panelMessageId,
      };
      await this.service.configure(cfg, actor);
      await i.editReply('Configuração salva. Use /salas painel para publicar o painel. O catálogo inicial fica restrito aos IDs atualmente disponíveis.'); return;
    }
    if (sub === 'cargos') {
      requireCondition(actor.administrator, 'FORBIDDEN', 'Somente a administração pode configurar cargos.');
      const cfg = this.settings(i.guildId); const key = o.getString('grupo', true);
      requireCondition(['operatorRoleIds', 'managerRoleIds', 'viewerRoleIds'].includes(key), 'INVALID_ROOM_SETTINGS', 'Grupo de cargos inválido.');
      const field = key as 'operatorRoleIds' | 'managerRoleIds' | 'viewerRoleIds'; const role = o.getRole('cargo', true).id;
      const values = o.getString('acao', true) === 'add' ? [...new Set([...cfg[field], role])] : cfg[field].filter(id => id !== role);
      await this.service.configure({ ...cfg, [field]: values }, actor); await i.editReply('Cargos atualizados. As próximas ações usam as permissões atuais.'); return;
    }
    if (sub === 'painel') { requireCondition(actor.administrator, 'FORBIDDEN', 'Somente a administração pode publicar o painel.'); await this.callbacks.publishPanel(i.guildId); await i.editReply('Painel publicado ou recuperado.'); return; }
    if (sub === 'catalogo') {
      const catalog = this.service.settings(i.guildId) ? await this.service.catalog(i.guildId, actor) : await this.service.availableCatalog(actor);
      const lines = catalog.modes.map(m => `**${m.label}** • \`${m.id}\` • ${m.minPlayers}–${m.maxPlayers} jogadores\nMapas: ${m.mapIds.join(', ')}\nExtras: ${m.optionFields.map(f => `${f.id}${f.required ? '*' : ''}`).join(', ') || 'nenhum'}`);
      await i.editReply({ embeds: [new EmbedBuilder().setTitle('Catálogo de salas').setDescription(lines.join('\n\n').slice(0, 4000) || 'Catálogo vazio.')], allowedMentions: roomNoMentions }); return;
    }
    if (sub === 'sincronizar') { await this.showRoom(i, o.getString('id', true), true); return; }
    await this.list(i, sub === 'minhas', o.getInteger('pagina') ?? 1, (o.getString('estado') ?? undefined) as ManagedRoomState | undefined, o.getUser('criador')?.id);
  }

  private async component(i: MessageInteraction): Promise<void> {
    const parts = i.customId.split(':'); const action = parts[1];
    if (action === 'lookup') {
      await i.showModal(new ModalBuilder().setCustomId('room:lookup-submit').setTitle('Consultar sala')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('id').setLabel('ID interno da sala').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)))); return;
    }
    if (action === 'cancel' || action === 'close') {
      const id = parts[2]; requireCondition(id, 'ROOM_ID', 'Sala inválida.'); this.service.get(i.guildId, id, this.actor(i));
      await i.showModal(this.actionModal(id, action)); return;
    }
    if (action !== 'w') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (action === 'new') await this.begin(i);
      else if (action === 'edit') { requireCondition(parts[2], 'ROOM_ID', 'Sala inválida.'); await this.begin(i, parts[2]); }
      else if (action === 'sync') { requireCondition(parts[2], 'ROOM_ID', 'Sala inválida.'); await this.showRoom(i, parts[2], true); }
      else if (action === 'mine' || action === 'list') await this.list(i, action === 'mine', integer(parts[2] ?? '1', 'Página'));
      else throw new DomainError('ROOM_BUTTON', 'Controle de salas desconhecido.');
      return;
    }
    const s = this.session(i, parts[2] ?? '', parts[3] ?? ''); const step = parts[4];
    if (step === 'details') {
      requireCondition(s.stage === 'details', 'ROOM_SESSION_STATE', 'Use a etapa atual do assistente.');
      await i.showModal(this.modal(s, 'details')); return;
    }
    if (step === 'extra-input') { requireCondition(s.stage === 'extra', 'ROOM_SESSION_STATE', 'Use a etapa atual do assistente.'); await i.showModal(this.modal(s, 'extra-input')); return; }
    await i.deferUpdate();
    if (step === 'abort') {
      if (s.kind !== 'update' && s.roomId) await this.service.cancel(i.guildId, s.roomId, this.actor(i), 'Rascunho descartado pelo criador.');
      this.sessions.delete(s.id); await i.editReply({ content: 'Assistente encerrado. Nenhuma nova criação foi solicitada.', embeds: [], components: [] }); return;
    }
    if (step === 'confirm') {
      requireCondition(s.stage === 'preview' && s.roomId, 'ROOM_SESSION_STATE', 'Prévia inválida ou já utilizada.');
      s.stage = 'executing'; s.version++;
      await i.editReply({ content: 'Solicitação registrada. Aguarde a confirmação do provedor.', components: [] });
      let room: ManagedRoom;
      const actor = await this.refreshActor(i);
      if (s.kind === 'update') room = await this.service.update(i.guildId, s.roomId, actor, s.options);
      else {
        if (s.kind === 'draft') await this.service.update(i.guildId, s.roomId, actor, s.options);
        room = await this.service.create(i.guildId, s.roomId, await this.refreshActor(i));
      }
      this.sessions.delete(s.id);
      room = this.service.get(i.guildId, room.id, await this.refreshActor(i));
      if (room.confirmed) await this.callbacks.publish(room);
      room = this.service.get(i.guildId, room.id, await this.refreshActor(i));
      await i.editReply({ content: room.confirmed && !room.pending ? 'Operação confirmada pelo provedor.' : 'Operação pendente de confirmação. Consulte o estado; não crie outra sala para repetir a tentativa.', embeds: [roomEmbed(room, true)], components: roomControls(room), allowedMentions: roomNoMentions }); return;
    }
    if (step === 'mode-page' || step === 'map-page' || step === 'extra-page') { await i.editReply({ ...this.render(s, integer(parts[5] ?? '0', 'Página')), allowedMentions: roomNoMentions }); return; }
    if (step === 'skip') { requireCondition(s.stage === 'extra' && !this.extras(s)[s.extraIndex]?.required, 'ROOM_SESSION_STATE', 'Esta opção é obrigatória.'); s.version++; await this.advanceExtra(s, this.actor(i)); }
    else if (i.isStringSelectMenu()) {
      const value = i.values[0]; requireCondition(i.values.length === 1 && value, 'ROOM_OPTION', 'Selecione uma opção válida.');
      if (step === 'mode') {
        requireCondition(s.stage === 'mode' && s.catalog.modes.some(m => m.id === value), 'ROOM_OPTION', 'Modo inválido.');
        const selectedMode = s.catalog.modes.find(m => m.id === value)!;
        s.options.modeId = value;
        if (this.editable(s, 'mapId')) s.options.mapId = '';
        s.options.extras = Object.fromEntries(Object.entries(s.options.extras).filter(([key]) => selectedMode.optionFields.some(f => f.id === key)));
        s.version++; s.stage = this.editable(s, 'mapId') ? 'map' : this.baseFields(s).length ? 'details' : 'extra';
        if (s.stage === 'extra' && !this.extras(s).length) await this.preview(s, this.actor(i));
      } else if (step === 'map') {
        requireCondition(s.stage === 'map' && this.mode(s).mapIds.includes(value), 'ROOM_OPTION', 'Mapa inválido.');
        s.options.mapId = value; s.version++; s.stage = this.baseFields(s).length ? 'details' : 'extra';
        if (s.stage === 'extra' && !this.extras(s).length) await this.preview(s, this.actor(i));
      } else if (step === 'extra') {
        requireCondition(s.stage === 'extra', 'ROOM_SESSION_STATE', 'Use a etapa atual.'); const field = this.extras(s)[s.extraIndex]!;
        requireCondition(field.type === 'boolean' ? ['true', 'false'].includes(value) : field.choices?.some(c => c.value === value), 'ROOM_OPTION', 'Opção inválida.');
        s.options.extras[field.id] = field.type === 'boolean' ? value === 'true' : value;
        s.version++; await this.advanceExtra(s, this.actor(i));
      } else throw new DomainError('ROOM_BUTTON', 'Seleção desconhecida.');
    } else throw new DomainError('ROOM_BUTTON', 'Controle desconhecido.');
    await i.editReply({ ...this.render(s), allowedMentions: roomNoMentions });
  }

  private async submit(i: ModalSubmitInteraction<'cached'>): Promise<void> {
    const parts = i.customId.split(':');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (parts[1] === 'lookup-submit') { await this.showRoom(i, i.fields.getTextInputValue('id').trim(), true); return; }
    if (parts[1] === 'end') {
      const action = parts[2]; const id = parts[3]; requireCondition((action === 'cancel' || action === 'close') && id, 'ROOM_ID', 'Operação inválida.');
      const reason = i.fields.getTextInputValue('reason').trim();
      let room = action === 'cancel' ? await this.service.cancel(i.guildId, id, await this.refreshActor(i), reason) : await this.service.close(i.guildId, id, await this.refreshActor(i), reason);
      room = this.service.get(i.guildId, id, await this.refreshActor(i));
      if (room.confirmed) await this.callbacks.publish(room);
      room = this.service.get(i.guildId, id, await this.refreshActor(i));
      await i.editReply({ content: room.pending ? 'Solicitação pendente de confirmação remota.' : 'Operação confirmada.', embeds: [roomEmbed(room, true)], components: roomControls(room), allowedMentions: roomNoMentions }); return;
    }
    requireCondition(parts[1] === 'w', 'ROOM_MODAL', 'Formulário desconhecido.');
    const s = this.session(i, parts[2] ?? '', parts[3] ?? ''); const action = parts[4];
    if (action === 'details-submit') {
      requireCondition(s.stage === 'details', 'ROOM_SESSION_STATE', 'Use a etapa atual.');
      const fields = this.baseFields(s);
      const candidate = { ...s.options, extras: { ...s.options.extras } };
      if (fields.includes('name')) {
        const name = i.fields.getTextInputValue('name').trim();
        requireCondition(name.length >= 1 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name), 'INVALID_ROOM_INPUT', 'O nome precisa ter de 1 a 80 caracteres, sem controles.');
        candidate.name = name;
      }
      if (fields.includes('maxPlayers')) {
        const capacity = integer(i.fields.getTextInputValue('maxPlayers').trim(), 'Capacidade'); const mode = this.mode(s);
        requireCondition(capacity >= mode.minPlayers && capacity <= mode.maxPlayers && (capacity - mode.minPlayers) % (mode.playerStep ?? 1) === 0, 'INVALID_ROOM_INPUT', 'A capacidade não corresponde aos limites do modo.');
        candidate.maxPlayers = capacity;
      }
      if (fields.includes('password')) {
        const password = i.fields.getTextInputValue('password');
        requireCondition(!password.trim() || /^[A-Za-z0-9_-]{1,64}$/.test(password), 'INVALID_ROOM_INPUT', 'A senha deve conter de 1 a 64 letras, números, _ ou -, sem espaços.');
        if (password.trim()) candidate.password = password; else delete candidate.password;
      }
      s.options = candidate;
      s.version++; await this.afterDetails(s, this.actor(i));
    } else if (action === 'extra-input-submit') {
      requireCondition(s.stage === 'extra', 'ROOM_SESSION_STATE', 'Use a etapa atual.'); const field = this.extras(s)[s.extraIndex]!;
      const value = i.fields.getTextInputValue('value').trim();
      if (!value && !field.required) delete s.options.extras[field.id];
      else {
        if (field.type === 'integer') {
          requireCondition(/^-?\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= (field.min ?? 0) && Number(value) <= (field.max ?? Number.MAX_SAFE_INTEGER), 'INVALID_ROOM_INPUT', 'A opção numérica não respeita os limites do catálogo.');
          s.options.extras[field.id] = Number(value);
        } else {
          requireCondition(value.length <= (field.maxLength ?? 200), 'INVALID_ROOM_INPUT', 'O texto excede o limite do catálogo.');
          s.options.extras[field.id] = value;
        }
      }
      s.version++; await this.advanceExtra(s, this.actor(i));
    } else throw new DomainError('ROOM_MODAL', 'Formulário desconhecido.');
    await i.editReply({ ...this.render(s), allowedMentions: roomNoMentions });
  }
}
