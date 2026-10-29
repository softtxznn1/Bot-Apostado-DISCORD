import { createHash } from 'node:crypto';
import { DomainError, requireCondition, type Match, type Room } from './domain.js';
import { validateRoom, type RoomProvider } from './providers.js';

export type RoomContext = Pick<Match, 'id' | 'teamSize' | 'platform' | 'rules'>;
export type HttpRoomProviderOptions = {
  /** Explicit acceptance of this application's contract, not a provider certification. */
  contract: 'room-contract-v1';
  baseUrl: string;
  apiKey: string;
  createPath: string;
  lookupPath?: string;
  lookupMethod?: 'GET' | 'POST';
  authorizationScheme?: 'Bearer' | 'raw';
  getMatch(reference: string): RoomContext;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Only for a test server bound to localhost; never enabled by environment variables. */
  allowLocalHttpForTests?: boolean;
};

export class RoomApiError extends DomainError {
  constructor(code: string, message: string, public readonly httpStatus?: number) {
    super(code, message);
  }
}

const failConfig = (condition: unknown, message: string): void => {
  requireCondition(condition, 'ROOM_API_CONFIG', message);
};
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * HTTP implementation of the explicit room-contract-v1 documented in docs/ROOM_API.md.
 * No Free Fire vendor is selected or certified by this class.
 */
export class HttpRoomProvider implements RoomProvider {
  readonly kind = 'external' as const;
  readonly identity: string;
  private readonly baseUrl: URL;
  readonly #authorization: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly options: Readonly<Omit<HttpRoomProviderOptions, 'apiKey'>>;

  constructor(options: HttpRoomProviderOptions) {
    const { apiKey: _apiKey, ...nonSecretOptions } = options;
    this.options = nonSecretOptions;
    failConfig(options.contract === 'room-contract-v1', 'Confirme explicitamente o contrato room-contract-v1 antes de ativar a API.');
    let parsed: URL;
    try { parsed = new URL(options.baseUrl); }
    catch { throw new DomainError('ROOM_API_CONFIG', 'A URL base da API de salas é inválida.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    failConfig(parsed.protocol === 'https:' || (options.allowLocalHttpForTests === true && loopback && parsed.protocol === 'http:'), 'A API de salas exige HTTPS; HTTP local só pode ser usado em testes explícitos.');
    failConfig(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/', 'Use somente a origem da API, sem credenciais, caminhos, query ou fragmento na URL base.');
    failConfig(typeof options.apiKey === 'string' && options.apiKey.length >= 1 && options.apiKey.length <= 4096 && !/[\r\n\u0000]/.test(options.apiKey), 'Configure a chave da API em uma variável segura, sem quebras de linha.');
    failConfig(options.authorizationScheme === undefined || options.authorizationScheme === 'Bearer' || options.authorizationScheme === 'raw', 'Esquema de autenticação inválido.');
    failConfig(options.lookupMethod === undefined || options.lookupMethod === 'GET' || options.lookupMethod === 'POST', 'O método de consulta precisa ser GET ou POST.');
    this.checkPath(options.createPath);
    if (options.lookupPath !== undefined) this.checkPath(options.lookupPath);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    failConfig(Number.isInteger(this.timeoutMs) && this.timeoutMs >= 20 && this.timeoutMs <= 60_000, 'O timeout da API precisa estar entre 20 e 60000 milissegundos.');
    failConfig(Number.isInteger(this.maxResponseBytes) && this.maxResponseBytes >= 256 && this.maxResponseBytes <= 1024 * 1024, 'O limite da resposta precisa estar entre 256 bytes e 1 MiB.');
    this.baseUrl = parsed;
    this.#authorization = options.authorizationScheme === 'raw' ? options.apiKey : `Bearer ${options.apiKey}`;
    this.identity = `http-room-v1:${createHash('sha256').update(JSON.stringify({
      contract: options.contract, origin: parsed.origin, createPath: options.createPath,
      lookupPath: options.lookupPath ?? null, lookupMethod: options.lookupMethod ?? 'GET',
    })).digest('hex')}`;
  }

  private checkPath(path: string): void {
    failConfig(typeof path === 'string' && /^\/[A-Za-z0-9_/:.-]+$/.test(path) && !path.startsWith('//') && !path.split('/').some(part => part === '.' || part === '..'), 'Configure um caminho absoluto da mesma origem, sem query, credenciais ou segmentos relativos.');
  }

  private reference(reference: string): void {
    requireCondition(typeof reference === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(reference), 'ROOM_API_REFERENCE', 'Referência da partida inválida.');
  }

  private normalize(value: unknown, reference: string): Room {
    if (!isObject(value) || value.reference !== reference || !isObject(value.room)) {
      throw new RoomApiError('ROOM_API_RESPONSE', 'A resposta da API não corresponde à referência e ao contrato de sala esperados.');
    }
    const room: Room = { id: value.room.id as string, password: value.room.password as string, source: 'external' };
    try { validateRoom(room); }
    catch { throw new RoomApiError('ROOM_API_RESPONSE', 'A API devolveu dados de sala inválidos.'); }
    return room;
  }

  private async request(path: string, method: 'GET' | 'POST', reference: string, body?: Record<string, unknown>, lookup = false): Promise<unknown | undefined> {
    const url = new URL(path, this.baseUrl);
    if (method === 'GET') url.searchParams.set('reference', reference);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // No retry and no redirect: a failed response does not prove that no room was created.
      const response = await fetch(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: this.#authorization,
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(!lookup ? { 'Idempotency-Key': reference } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? { reference }) } : {}),
      });
      if (lookup && [202, 404, 410].includes(response.status)) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status !== 200 && response.status !== 201) {
        await response.body?.cancel();
        throw new RoomApiError('ROOM_API_HTTP', 'A API não confirmou a operação. Consulte a solicitação antes de tentar criar outra sala.', response.status);
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        await response.body?.cancel();
        throw new RoomApiError('ROOM_API_RESPONSE', 'A API precisa responder com application/json.');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.maxResponseBytes)) {
        controller.abort();
        throw new RoomApiError('ROOM_API_RESPONSE', 'A resposta da API excedeu o limite permitido.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new RoomApiError('ROOM_API_RESPONSE', 'A API respondeu sem dados de sala.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > this.maxResponseBytes) {
            controller.abort();
            throw new RoomApiError('ROOM_API_RESPONSE', 'A resposta da API excedeu o limite permitido.');
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RoomApiError('ROOM_API_RESPONSE', 'A API devolveu JSON inválido.'); }
      if (lookup && isObject(parsed) && parsed.reference === reference && parsed.status === 'pending' && !('room' in parsed)) return undefined;
      return parsed;
    } catch (error) {
      if (error instanceof RoomApiError) throw error;
      // Do not retain fetch exceptions, URLs, response bodies or authorization in messages/causes.
      throw new RoomApiError('ROOM_API_UNCERTAIN', 'A comunicação com a API ficou incerta. Verifique a solicitação antes de criar novamente.');
    } finally { clearTimeout(timer); }
  }

  async createRoom(reference: string): Promise<Room> {
    this.reference(reference);
    const match = this.options.getMatch(reference);
    requireCondition(match.id === reference && Number.isInteger(match.teamSize) && match.teamSize >= 1 && match.teamSize <= 4
      && ['mobile', 'emulador', 'misto'].includes(match.platform) && typeof match.rules === 'string'
      && match.rules.length >= 3 && match.rules.length <= 200, 'ROOM_API_CONTEXT', 'Os dados da partida não são válidos para a solicitação de sala.');
    const response = await this.request(this.options.createPath, 'POST', reference, {
      reference, mode: `${match.teamSize}x${match.teamSize}`, platform: match.platform, rules: match.rules,
    });
    return this.normalize(response, reference);
  }

  async findRoom(reference: string): Promise<Room | undefined> {
    this.reference(reference);
    if (!this.options.lookupPath) return undefined;
    const response = await this.request(this.options.lookupPath, this.options.lookupMethod ?? 'GET', reference, { reference }, true);
    return response === undefined ? undefined : this.normalize(response, reference);
  }
}
