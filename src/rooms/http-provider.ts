import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { DomainError, requireCondition } from '../domain.js';
import type { ManagedRoomProvider, ProviderRoom, RoomCatalog, RoomMode, RoomOptionField, RoomOptions, RoomValue } from './types.js';

export type HttpManagedRoomProviderOptions = {
  contract: 'room-management-v2'; baseUrl: string; apiKey: string;
  authorizationScheme?: 'Bearer' | 'raw'; timeoutMs?: number; maxResponseBytes?: number;
  /** Relógio substituível para verificar cooldown sem aguardar tempo real nos testes. */
  now?: () => number;
  /** Somente servidor local de testes; não há variável de ambiente para relaxar TLS. */
  allowLocalHttpForTests?: boolean;
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const safeText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const DEFAULT_RATE_LIMIT_MS = 30_000;
const MAX_RATE_LIMIT_MS = 86_400_000;
function retryDelayMs(header: string | null, now: number): number {
  if (header === null || header.length > 100) return DEFAULT_RATE_LIMIT_MS;
  const value = header.trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1000
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) - now : NaN;
  if (Number.isNaN(delay) || delay < 0) return DEFAULT_RATE_LIMIT_MS;
  // A resposta nunca agenda uma retentativa; somente impede novas chamadas.
  // O mínimo evita busy loops e o teto limita datas/cabeçalhos absurdos.
  return Math.min(MAX_RATE_LIMIT_MS, Math.max(1000, delay));
}
function rateLimited(): DomainError {
  return new DomainError('ROOM_PROVIDER_RATE_LIMITED', 'A API limitou as solicitações. Aguarde antes de consultar novamente; nenhuma escrita foi repetida automaticamente.');
}
function response(condition: unknown): asserts condition {
  requireCondition(condition, 'ROOM_PROVIDER_RESPONSE', 'A API de salas retornou dados incompatíveis com o contrato configurado.');
}
function object(v: unknown): Record<string, unknown> { response(record(v)); return v; }
function extras(v: unknown): Record<string, RoomValue> {
  const values = object(v); response(Object.keys(values).length <= 30);
  const entries = Object.entries(values).map(([key, value]) => {
    response(validId(key) && !['__proto__', 'prototype', 'constructor'].includes(key));
    response(typeof value === 'boolean' || (typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value)));
    return [key, value as RoomValue] as const;
  });
  return Object.fromEntries(entries);
}
function unique(ids: readonly string[]): void { response(new Set(ids).size === ids.length); }
function optionField(value: unknown): RoomOptionField {
  const v = object(value);
  response(validId(v.id) && !['__proto__', 'prototype', 'constructor'].includes(v.id) && safeText(v.label, 100) && ['string', 'integer', 'boolean', 'choice'].includes(v.type as string));
  response(v.required === undefined || typeof v.required === 'boolean');
  response(v.editable === undefined || typeof v.editable === 'boolean');
  const field: RoomOptionField = { id: v.id, label: v.label, type: v.type as RoomOptionField['type'] };
  if (v.required !== undefined) field.required = v.required as boolean;
  if (v.editable !== undefined) field.editable = v.editable as boolean;
  for (const key of ['min', 'max'] as const) if (v[key] !== undefined) {
    response(v.type === 'integer' && whole(v[key], -1_000_000, 1_000_000)); field[key] = v[key];
  }
  response(field.min === undefined || field.max === undefined || field.min <= field.max);
  if (v.maxLength !== undefined) { response(v.type === 'string' && whole(v.maxLength, 1, 200)); field.maxLength = v.maxLength; }
  if (v.type === 'choice') {
    response(Array.isArray(v.choices) && v.choices.length >= 1 && v.choices.length <= 100);
    field.choices = v.choices.map(choice => { const c = object(choice); response(safeText(c.value, 100) && safeText(c.label, 100)); return { value: c.value, label: c.label }; });
    unique(field.choices.map(c => c.value));
  } else response(v.choices === undefined);
  return field;
}

/** Seleciona somente campos do contrato; nunca devolve o objeto bruto do fornecedor. */
export function normalizeManagedCatalog(value: unknown): RoomCatalog {
  const v = object(value); response(safeText(v.revision, 100));
  response(Array.isArray(v.maps) && v.maps.length > 0 && v.maps.length <= 1000);
  const maps = v.maps.map(map => { const m = object(map); response(validId(m.id) && safeText(m.label, 100)); return { id: m.id, label: m.label }; });
  unique(maps.map(m => m.id)); const mapIds = new Set(maps.map(m => m.id));
  response(Array.isArray(v.modes) && v.modes.length > 0 && v.modes.length <= 100);
  const modes: RoomMode[] = v.modes.map(mode => {
    const m = object(mode);
    response(validId(m.id) && safeText(m.label, 100) && whole(m.minPlayers, 1, 1000) && whole(m.maxPlayers, m.minPlayers, 1000));
    response(Array.isArray(m.mapIds) && m.mapIds.length > 0 && m.mapIds.length <= 1000 && m.mapIds.every(id => validId(id) && mapIds.has(id)));
    unique(m.mapIds as string[]);
    response(m.playerStep === undefined || whole(m.playerStep, 1, 1000));
    response(Array.isArray(m.editableFields) && m.editableFields.length <= 5
      && m.editableFields.every(field => ['name', 'modeId', 'mapId', 'maxPlayers', 'password'].includes(field as string)));
    unique(m.editableFields as string[]);
    response(Array.isArray(m.optionFields) && m.optionFields.length <= 30);
    const optionFields = m.optionFields.map(optionField); unique(optionFields.map(f => f.id));
    return { id: m.id, label: m.label, mapIds: m.mapIds as string[], minPlayers: m.minPlayers, maxPlayers: m.maxPlayers, editableFields: m.editableFields as RoomMode['editableFields'],
      ...(m.playerStep !== undefined ? { playerStep: m.playerStep as number } : {}), optionFields };
  });
  unique(modes.map(m => m.id));
  const c = object(v.capabilities);
  for (const key of ['create', 'lookup', 'query', 'update', 'cancel', 'close']) response(typeof c[key] === 'boolean');
  return { revision: v.revision, modes, maps, capabilities: {
    create: c.create as boolean, lookup: c.lookup as boolean, query: c.query as boolean,
    update: c.update as boolean, cancel: c.cancel as boolean, close: c.close as boolean,
  } };
}

export function normalizeProviderRoom(value: unknown): ProviderRoom {
  const v = object(value);
  response(validId(v.id) && validId(v.reference) && ['open', 'running', 'cancelled', 'closed', 'expired'].includes(v.state as string));
  response(safeText(v.name, 100) && validId(v.modeId) && validId(v.mapId) && whole(v.maxPlayers, 1, 1000));
  response(v.password === null || safeText(v.password, 64));
  response(v.expiresAt === undefined || whole(v.expiresAt, 1, Number.MAX_SAFE_INTEGER));
  return { id: v.id, reference: v.reference, state: v.state as ProviderRoom['state'], name: v.name,
    modeId: v.modeId, mapId: v.mapId, maxPlayers: v.maxPlayers, password: v.password, extras: extras(v.extras),
    ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt as number } : {}) };
}

function inputOptions(options: RoomOptions): RoomOptions {
  requireCondition(record(options) && safeText(options.name, 100) && validId(options.modeId) && validId(options.mapId)
    && whole(options.maxPlayers, 1, 1000) && (options.password === undefined || safeText(options.password, 64)), 'ROOM_OPTIONS', 'Opções da sala inválidas.');
  return { name: options.name, modeId: options.modeId, mapId: options.mapId, maxPlayers: options.maxPlayers,
    ...(options.password === undefined ? {} : { password: options.password }), extras: extras(options.extras) };
}
function identifier(value: string): string {
  requireCondition(validId(value), 'ROOM_REFERENCE', 'Identificador de sala ou operação inválido.'); return encodeURIComponent(value);
}

/** API completa do contrato explícito deste projeto; não certifica fornecedor de Free Fire. */
export class HttpManagedRoomProvider implements ManagedRoomProvider {
  readonly source = 'external' as const;
  readonly identity: string;
  #origin: string; #authorization: string; #timeoutMs: number; #maxBytes: number;
  #now: () => number; #rateLimitUntil = 0;
  constructor(options: HttpManagedRoomProviderOptions) {
    requireCondition(options.contract === 'room-management-v2', 'ROOM_PROVIDER_CONFIG', 'Confirme o contrato room-management-v2 antes de ativar o adaptador.');
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new DomainError('ROOM_PROVIDER_CONFIG', 'Origem da API de salas inválida.'); }
    const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
    requireCondition(url.protocol === 'https:' || (options.allowLocalHttpForTests === true && local && url.protocol === 'http:'), 'ROOM_PROVIDER_CONFIG', 'A API exige HTTPS. HTTP literal de loopback é permitido somente em testes explícitos.');
    requireCondition(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'ROOM_PROVIDER_CONFIG', 'Configure somente a origem HTTPS, sem caminho, credencial ou parâmetros.');
    requireCondition(typeof options.apiKey === 'string' && options.apiKey.length >= 1 && options.apiKey.length <= 4096 && !/[\r\n\u0000]/.test(options.apiKey), 'ROOM_PROVIDER_CONFIG', 'Configure uma credencial segura para a API.');
    requireCondition(options.authorizationScheme === undefined || options.authorizationScheme === 'Bearer' || options.authorizationScheme === 'raw', 'ROOM_PROVIDER_CONFIG', 'Esquema de autenticação inválido.');
    this.#timeoutMs = options.timeoutMs ?? 10_000; this.#maxBytes = options.maxResponseBytes ?? 65_536;
    requireCondition(whole(this.#timeoutMs, 20, 60_000) && whole(this.#maxBytes, 256, 1_048_576), 'ROOM_PROVIDER_CONFIG', 'Timeout ou limite de resposta inválido.');
    this.#origin = url.origin; this.#authorization = options.authorizationScheme === 'raw' ? options.apiKey : `Bearer ${options.apiKey}`;
    this.#now = options.now ?? Date.now;
    this.identity = `room-management-v2:${createHash('sha256').update(url.origin).digest('hex')}`;
  }
  [inspect.custom](): string { return 'HttpManagedRoomProvider { credentials: [REDACTED] }'; }

  async #request(path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown, key?: string, lookup = false): Promise<unknown | undefined> {
    if (this.#now() < this.#rateLimitUntil) throw rateLimited();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const result = await fetch(this.#origin + path, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: this.#authorization, Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (result.status === 429) {
        const now = this.#now();
        this.#rateLimitUntil = Math.max(this.#rateLimitUntil, now + retryDelayMs(result.headers.get('retry-after'), now));
        await result.body?.cancel(); throw rateLimited();
      }
      if ((result.status === 202 && (method !== 'GET' || lookup)) || (lookup && result.status === 404)) {
        await result.body?.cancel(); return undefined;
      }
      if (![200, 201].includes(result.status)) {
        await result.body?.cancel();
        throw new DomainError(method === 'GET' ? 'ROOM_PROVIDER_UNAVAILABLE' : 'ROOM_PROVIDER_UNCERTAIN', 'A API não confirmou a operação. Consulte o estado antes de repetir qualquer escrita.');
      }
      if (result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        await result.body?.cancel(); throw new DomainError('ROOM_PROVIDER_RESPONSE', 'A API precisa retornar application/json.');
      }
      const length = result.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.#maxBytes)) {
        await result.body?.cancel(); throw new DomainError('ROOM_PROVIDER_RESPONSE', 'Resposta da API excede o limite permitido.');
      }
      const reader = result.body?.getReader(); response(reader);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > this.#maxBytes) { controller.abort(); throw new DomainError('ROOM_PROVIDER_RESPONSE', 'Resposta da API excede o limite permitido.'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new DomainError('ROOM_PROVIDER_RESPONSE', 'A API não retornou JSON válido.'); }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(method === 'GET' ? 'ROOM_PROVIDER_UNAVAILABLE' : 'ROOM_PROVIDER_UNCERTAIN', 'Comunicação com a API não confirmada. Nenhuma repetição automática foi enviada.');
    } finally { clearTimeout(timer); }
  }
  #room(value: unknown, expected: { id?: string; reference?: string }): ProviderRoom {
    const room = normalizeProviderRoom(object(value).room);
    response((expected.id === undefined || room.id === expected.id) && (expected.reference === undefined || room.reference === expected.reference));
    return room;
  }
  async getCatalog(): Promise<RoomCatalog> { return normalizeManagedCatalog(object(await this.#request('/v2/catalog', 'GET')).catalog); }
  async createRoom(request: { reference: string; options: RoomOptions; idempotencyKey: string }): Promise<ProviderRoom | undefined> {
    identifier(request.reference); identifier(request.idempotencyKey);
    const result = await this.#request('/v2/rooms', 'POST', { reference: request.reference, options: inputOptions(request.options) }, request.idempotencyKey);
    return result === undefined ? undefined : this.#room(result, { reference: request.reference });
  }
  async getRoom(remoteId: string): Promise<ProviderRoom> {
    return this.#room(await this.#request(`/v2/rooms/${identifier(remoteId)}`, 'GET'), { id: remoteId });
  }
  async findRoom(reference: string): Promise<ProviderRoom | undefined> {
    identifier(reference);
    const result = await this.#request(`/v2/rooms/lookup?reference=${encodeURIComponent(reference)}`, 'GET', undefined, undefined, true);
    return result === undefined ? undefined : this.#room(result, { reference });
  }
  async updateRoom(remoteId: string, options: RoomOptions, idempotencyKey: string): Promise<ProviderRoom | undefined> {
    identifier(idempotencyKey);
    const result = await this.#request(`/v2/rooms/${identifier(remoteId)}`, 'PATCH', { options: inputOptions(options) }, idempotencyKey);
    return result === undefined ? undefined : this.#room(result, { id: remoteId });
  }
  async #finish(remoteId: string, key: string, reason: string, action: 'cancel' | 'close'): Promise<ProviderRoom | undefined> {
    identifier(key); requireCondition(safeText(reason, 300), 'ROOM_REASON', 'Informe um motivo de 1 a 300 caracteres.');
    const result = await this.#request(`/v2/rooms/${identifier(remoteId)}/${action}`, 'POST', { reason }, key);
    return result === undefined ? undefined : this.#room(result, { id: remoteId });
  }
  cancelRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom | undefined> { return this.#finish(remoteId, idempotencyKey, reason, 'cancel'); }
  closeRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom | undefined> { return this.#finish(remoteId, idempotencyKey, reason, 'close'); }
}
