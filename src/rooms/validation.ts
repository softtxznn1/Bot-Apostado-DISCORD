import { requireCondition } from '../domain.js';
import type { ProviderRoom, RoomCatalog, RoomOptionField, RoomOptions, RoomSettings, RoomValue } from './types.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const terminalStates = new Set(['open', 'running', 'cancelled', 'closed', 'expired']);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const safeText = (v: unknown, max: number, empty = false): v is string => typeof v === 'string'
  && v.length <= max && (empty || v.trim().length > 0) && !/[\x00-\x1f\x7f]/.test(v);

function identifier(v: unknown): asserts v is string {
  requireCondition(typeof v === 'string' && idPattern.test(v) && !['__proto__', 'prototype', 'constructor'].includes(v), 'INVALID_ROOM_ID', 'Identificador de configuração de sala inválido.');
}
function ids(v: unknown, nonempty = false): asserts v is string[] {
  requireCondition(Array.isArray(v) && v.length <= 1000 && (!nonempty || v.length > 0), 'INVALID_ROOM_SETTINGS', 'Lista de opções inválida ou vazia.');
  for (const value of v) identifier(value);
  requireCondition(new Set(v).size === v.length, 'INVALID_ROOM_SETTINGS', 'Não repita identificadores na configuração.');
}
function field(v: unknown): asserts v is RoomOptionField {
  requireCondition(plain(v), 'INVALID_ROOM_CATALOG', 'Campo de catálogo inválido.');
  identifier(v.id);
  requireCondition(safeText(v.label, 100) && ['string', 'integer', 'boolean', 'choice'].includes(String(v.type)), 'INVALID_ROOM_CATALOG', 'Campo de catálogo sem rótulo ou tipo válido.');
  requireCondition((v.required === undefined || typeof v.required === 'boolean') && (v.editable === undefined || typeof v.editable === 'boolean'), 'INVALID_ROOM_CATALOG', 'Metadados do campo inválidos.');
  for (const number of [v.min, v.max]) requireCondition(number === undefined || Number.isSafeInteger(number), 'INVALID_ROOM_CATALOG', 'Limites do campo inválidos.');
  requireCondition(v.maxLength === undefined || (Number.isSafeInteger(v.maxLength) && Number(v.maxLength) >= 0), 'INVALID_ROOM_CATALOG', 'Limite de texto inválido.');
  if (v.min !== undefined && v.max !== undefined) requireCondition(Number(v.min) <= Number(v.max), 'INVALID_ROOM_CATALOG', 'Limites do campo invertidos.');
  if (v.type === 'choice') {
    requireCondition(Array.isArray(v.choices) && v.choices.length > 0 && v.choices.length <= 1000, 'INVALID_ROOM_CATALOG', 'Campo de escolha sem alternativas.');
    for (const choice of v.choices) requireCondition(plain(choice) && safeText(choice.value, 100) && safeText(choice.label, 100), 'INVALID_ROOM_CATALOG', 'Alternativa de campo inválida.');
    requireCondition(new Set(v.choices.map(c => c.value)).size === v.choices.length, 'INVALID_ROOM_CATALOG', 'Alternativas de campo repetidas.');
  }
}

export function validateCatalog(value: unknown): RoomCatalog {
  requireCondition(plain(value) && safeText(value.revision, 100) && Array.isArray(value.modes) && value.modes.length > 0 && value.modes.length <= 1000
    && Array.isArray(value.maps) && value.maps.length > 0 && value.maps.length <= 1000 && plain(value.capabilities), 'INVALID_ROOM_CATALOG', 'O provedor não retornou um catálogo válido de salas.');
  for (const key of ['create', 'lookup', 'query', 'update', 'cancel', 'close']) requireCondition(typeof value.capabilities[key] === 'boolean', 'INVALID_ROOM_CATALOG', 'Capacidades do provedor não informadas.');
  const mapIds: string[] = [];
  for (const map of value.maps) {
    requireCondition(plain(map) && safeText(map.label, 100), 'INVALID_ROOM_CATALOG', 'Mapa inválido no catálogo.'); identifier(map.id); mapIds.push(map.id);
  }
  requireCondition(new Set(mapIds).size === mapIds.length, 'INVALID_ROOM_CATALOG', 'Mapas repetidos no catálogo.');
  const modeIds: string[] = [];
  for (const mode of value.modes) {
    requireCondition(plain(mode) && safeText(mode.label, 100), 'INVALID_ROOM_CATALOG', 'Modo inválido no catálogo.'); identifier(mode.id); modeIds.push(mode.id);
    ids(mode.mapIds, true);
    requireCondition(mode.mapIds.every(map => mapIds.includes(map)), 'INVALID_ROOM_CATALOG', 'Modo referencia mapa não listado.');
    requireCondition(Number.isInteger(mode.minPlayers) && Number(mode.minPlayers) >= 1 && Number.isInteger(mode.maxPlayers)
      && Number(mode.maxPlayers) >= Number(mode.minPlayers) && Number(mode.maxPlayers) <= 1000,
    'INVALID_ROOM_CATALOG', 'Capacidade inválida no catálogo.');
    requireCondition(mode.playerStep === undefined || (Number.isInteger(mode.playerStep) && Number(mode.playerStep) >= 1 && Number(mode.playerStep) <= 1000), 'INVALID_ROOM_CATALOG', 'Passo de capacidade inválido.');
    requireCondition(Array.isArray(mode.editableFields) && mode.editableFields.length <= 5 && new Set(mode.editableFields).size === mode.editableFields.length
      && mode.editableFields.every(key => ['name', 'modeId', 'mapId', 'maxPlayers', 'password'].includes(String(key))), 'INVALID_ROOM_CATALOG', 'Campos alteráveis do modo não informados corretamente.');
    requireCondition(Array.isArray(mode.optionFields) && mode.optionFields.length <= 50, 'INVALID_ROOM_CATALOG', 'Campos de opções inválidos.');
    for (const option of mode.optionFields) field(option);
    requireCondition(new Set(mode.optionFields.map(option => option.id)).size === mode.optionFields.length, 'INVALID_ROOM_CATALOG', 'Campos repetidos no catálogo.');
  }
  requireCondition(new Set(modeIds).size === modeIds.length, 'INVALID_ROOM_CATALOG', 'Modos repetidos no catálogo.');
  return structuredClone(value) as RoomCatalog;
}

export function validateSettings(value: RoomSettings): RoomSettings {
  identifier(value.guildId); identifier(value.panelChannelId); identifier(value.outputChannelId);
  if (value.logChannelId !== null) identifier(value.logChannelId);
  for (const roles of [value.operatorRoleIds, value.managerRoleIds, value.viewerRoleIds]) {
    ids(roles); requireCondition(!roles.includes(value.guildId) && roles.length <= 25, 'INVALID_ROOM_SETTINGS', 'Escolha cargos específicos, sem @everyone.');
  }
  ids(value.allowedModeIds, true); ids(value.allowedMapIds, true);
  if (value.allowedExtraIds !== undefined) ids(value.allowedExtraIds);
  requireCondition(Number.isInteger(value.maxActivePerUser) && value.maxActivePerUser >= 1 && value.maxActivePerUser <= 100
    && Number.isInteger(value.maxActivePerGuild) && value.maxActivePerGuild >= value.maxActivePerUser && value.maxActivePerGuild <= 1000,
  'INVALID_ROOM_SETTINGS', 'Defina limites de salas válidos por usuário e servidor.');
  requireCondition(Number.isInteger(value.cooldownSeconds) && value.cooldownSeconds >= 0 && value.cooldownSeconds <= 86_400, 'INVALID_ROOM_SETTINGS', 'Intervalo de criação inválido.');
  return structuredClone(value);
}

export function validateOptions(value: RoomOptions, catalog: RoomCatalog, settings?: RoomSettings): RoomOptions {
  requireCondition(plain(value) && safeText(value.name, 80), 'INVALID_ROOM_OPTIONS', 'O nome da sala precisa ter de 1 a 80 caracteres, sem controles.');
  if (settings) requireCondition(settings.allowedModeIds.includes(value.modeId) && settings.allowedMapIds.includes(value.mapId), 'ROOM_OPTION_DISABLED', 'Modo ou mapa não liberado neste servidor.');
  const mode = catalog.modes.find(m => m.id === value.modeId);
  requireCondition(mode && catalog.maps.some(m => m.id === value.mapId) && mode.mapIds.includes(value.mapId), 'INVALID_ROOM_OPTIONS', 'Modo ou mapa não disponível para esta criação.');
  requireCondition(Number.isInteger(value.maxPlayers) && value.maxPlayers >= mode.minPlayers && value.maxPlayers <= mode.maxPlayers
    && (value.maxPlayers - mode.minPlayers) % (mode.playerStep ?? 1) === 0, 'INVALID_ROOM_OPTIONS', 'A capacidade não corresponde aos limites do modo.');
  requireCondition(value.password === undefined || (typeof value.password === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.password)), 'INVALID_ROOM_OPTIONS', 'A senha deve conter de 1 a 64 letras, números, _ ou -.');
  requireCondition(plain(value.extras) && Object.keys(value.extras).length <= 50, 'INVALID_ROOM_OPTIONS', 'Opções adicionais inválidas.');
  const extras: Record<string, RoomValue> = {};
  for (const [key, option] of Object.entries(value.extras)) {
    requireCondition(!settings?.allowedExtraIds || settings.allowedExtraIds.includes(key), 'ROOM_OPTION_DISABLED', 'Uma opção adicional foi desabilitada neste servidor.');
    const definition = mode.optionFields.find(f => f.id === key);
    requireCondition(definition, 'INVALID_ROOM_OPTIONS', 'Uma opção adicional não pertence ao catálogo.');
    let valid = false;
    if (definition.type === 'boolean') valid = typeof option === 'boolean';
    if (definition.type === 'integer') valid = Number.isSafeInteger(option) && Number(option) >= (definition.min ?? Number.MIN_SAFE_INTEGER) && Number(option) <= (definition.max ?? Number.MAX_SAFE_INTEGER);
    if (definition.type === 'string') valid = safeText(option, Math.min(definition.maxLength ?? 200, 1000), !definition.required);
    if (definition.type === 'choice') valid = typeof option === 'string' && !!definition.choices?.some(c => c.value === option);
    requireCondition(valid, 'INVALID_ROOM_OPTIONS', 'Uma opção adicional não respeita o tipo ou os limites do catálogo.');
    extras[key] = option;
  }
  for (const definition of mode.optionFields) requireCondition(!definition.required || Object.hasOwn(extras, definition.id), 'INVALID_ROOM_OPTIONS', 'Preencha as opções obrigatórias do modo.');
  return { name: value.name.trim(), modeId: value.modeId, mapId: value.mapId, maxPlayers: value.maxPlayers,
    ...(value.password === undefined ? {} : { password: value.password }), extras };
}

export function validateProviderRoom(value: unknown): ProviderRoom {
  requireCondition(plain(value), 'INVALID_REMOTE_ROOM', 'O provedor não confirmou uma sala válida.');
  identifier(value.id); identifier(value.reference); identifier(value.modeId); identifier(value.mapId);
  requireCondition(terminalStates.has(String(value.state)) && safeText(value.name, 80)
    && Number.isInteger(value.maxPlayers) && Number(value.maxPlayers) >= 1 && Number(value.maxPlayers) <= 1000
    && (value.password === null || (typeof value.password === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.password)))
    && plain(value.extras), 'INVALID_REMOTE_ROOM', 'Dados de sala inválidos na resposta do provedor.');
  requireCondition(value.expiresAt === undefined || (Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0), 'INVALID_REMOTE_ROOM', 'Validade inválida na resposta do provedor.');
  const extras: Record<string, RoomValue> = {};
  requireCondition(Object.keys(value.extras).length <= 50, 'INVALID_REMOTE_ROOM', 'Excesso de opções na resposta do provedor.');
  for (const [key, option] of Object.entries(value.extras)) {
    identifier(key);
    requireCondition(typeof option === 'boolean' || Number.isSafeInteger(option) || safeText(option, 1000, true), 'INVALID_REMOTE_ROOM', 'Opção inválida na resposta do provedor.');
    extras[key] = option as RoomValue;
  }
  return { id: value.id, reference: value.reference, state: value.state as ProviderRoom['state'], name: value.name,
    modeId: value.modeId, mapId: value.mapId, maxPlayers: value.maxPlayers as number, password: value.password as string | null,
    extras, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number }) };
}

export function optionsMatchRoom(options: RoomOptions, room: ProviderRoom): boolean {
  return options.name === room.name && options.modeId === room.modeId && options.mapId === room.mapId
    && options.maxPlayers === room.maxPlayers && (options.password === undefined || options.password === room.password)
    && Object.entries(options.extras).every(([key, value]) => room.extras[key] === value);
}
