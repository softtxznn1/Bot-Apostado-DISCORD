import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import { extname } from 'node:path';
import { createSecureContext } from 'node:tls';
import { DomainError, requireCondition } from '../domain.js';
import type { CreatePixInput, PixGateway, PixPayment, PixStatus } from './types.js';

export type EfiPixConfig = {
  clientId: string; clientSecret: string; pixKey: string;
  certFile: string; keyFile?: string; passphrase?: string;
  sandbox: boolean; timeoutMs?: number;
};
export type EfiHttpRequest = {
  method: 'GET' | 'POST' | 'PUT'; url: URL;
  headers: Readonly<Record<string, string>>; body?: string;
  timeoutMs: number; maxResponseBytes: number;
};
export type EfiHttpResponse = { status: number; body: unknown };
/** Injeção explícita para testes; não existe variável que substitua ou relaxe TLS. */
export type EfiTransport = (input: EfiHttpRequest) => Promise<EfiHttpResponse>;
export type EfiDependencies = { transport?: EfiTransport; now?: () => number };
export type EfiRefund = { id: string; endToEndId: string; amountCents: number; status: 'pending' | 'refunded' | 'rejected' | 'unknown' };

const origins = { production: 'https://pix.api.efipay.com.br', sandbox: 'https://pix-h.api.efipay.com.br' } as const;
const bodyLimit = 1_048_576;
const certLimit = 524_288;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Json = Record<string, unknown>;

export class EfiHttpError extends DomainError {
  constructor(readonly status: number) {
    super('EFI_HTTP_ERROR', `A API Efí retornou HTTP ${status}. Nenhum payload ou credencial foi incluído no erro.`);
  }
}

function record(value: unknown): Json {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'EFI_INVALID_RESPONSE', 'A API Efí retornou um objeto inválido.');
  return value as Json;
}
function txid(value: string): string {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9]{26,35}$/.test(value), 'EFI_INVALID_TXID', 'A referência Efí deve ter de 26 a 35 letras ou números, sem hífens.');
  return value;
}
function cents(value: unknown): number {
  requireCondition(typeof value === 'string' && /^\d{1,12}\.\d{2}$/.test(value), 'EFI_INVALID_AMOUNT', 'A API Efí retornou um valor monetário inválido.');
  const [whole, fraction] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction);
  requireCondition(Number.isSafeInteger(amount) && amount >= 0, 'EFI_INVALID_AMOUNT', 'O valor Efí excede o limite de inteiros seguros.');
  return amount;
}
function amount(value: number): string {
  requireCondition(Number.isSafeInteger(value) && value > 0 && value <= 99_999_999_999_999, 'EFI_INVALID_AMOUNT', 'Informe um valor positivo e seguro em centavos.');
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
function certificateFile(filename: string): Buffer {
  try {
    const info = statSync(filename);
    requireCondition(info.isFile() && info.size > 0 && info.size <= certLimit, 'EFI_CERTIFICATE', 'O certificado/chave Efí precisa ser um arquivo válido e limitado a 512 KiB.');
    return readFileSync(filename);
  } catch {
    throw new DomainError('EFI_CERTIFICATE', 'Não foi possível carregar o certificado ou a chave Efí. Verifique o arquivo seguro e suas permissões.');
  }
}

/** Usa as CAs padrão do Node e a validação padrão de hostname; não há bypass. */
export function buildEfiHttpsAgent(config: Pick<EfiPixConfig, 'certFile' | 'keyFile' | 'passphrase'>): Agent {
  requireCondition(!!config.certFile, 'EFI_DISABLED', 'Efí desabilitada: configure EFI_CERT_FILE com o certificado mTLS.');
  try {
    const data = certificateFile(config.certFile);
    const pem = ['.pem', '.crt'].includes(extname(config.certFile).toLowerCase());
    if (pem) requireCondition(!!config.keyFile, 'EFI_CERTIFICATE', 'O certificado PEM Efí requer EFI_KEY_FILE com a chave privada correspondente.');
    const certificate = pem
      ? { cert: data, key: certificateFile(config.keyFile!), passphrase: config.passphrase ?? '' }
      : { pfx: data, passphrase: config.passphrase ?? '' };
    // Valida estrutura e passphrase antes de qualquer chamada autenticada.
    createSecureContext({ ...certificate, minVersion: 'TLSv1.2' });
    return new Agent({ ...certificate, proxyEnv: process.env, rejectUnauthorized: true, minVersion: 'TLSv1.2', keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('EFI_CERTIFICATE', 'Certificado Efí inválido, chave incompatível ou passphrase incorreta.');
  }
}

function secureTransport(agent: Agent): EfiTransport {
  return input => new Promise((resolve, reject) => {
    requireCondition(Object.values(origins).includes(input.url.origin as typeof origins.production), 'EFI_INVALID_HOST', 'O destino Efí não pertence aos hosts oficiais.');
    const fail = () => reject(new DomainError('EFI_CONNECTION', 'Falha de conexão Efí. Consulte a cobrança antes de repetir uma operação de escrita.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const req = httpsRequest(input.url, { method: input.method, agent, headers: input.headers, rejectUnauthorized: true }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxResponseBytes) { req.destroy(); response.destroy(); clearTimeout(timer); reject(new DomainError('EFI_RESPONSE_LIMIT', 'A resposta Efí excedeu o limite permitido.')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => { clearTimeout(timer); fail(); });
        response.on('end', () => {
          clearTimeout(timer);
          try {
            const data = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode ?? 0, body: data ? JSON.parse(data) as unknown : null });
          } catch { reject(new DomainError('EFI_INVALID_RESPONSE', 'A API Efí não retornou JSON válido.')); }
        });
      });
      timer = setTimeout(() => { req.destroy(); reject(new DomainError('EFI_TIMEOUT', 'Tempo limite Efí. O resultado de uma escrita pode ser incerto; consulte a referência antes de repetir.')); }, input.timeoutMs);
      timer.unref();
      req.on('error', () => { clearTimeout(timer); fail(); });
      // Sem redirects, sem retentativa automática e sem serializar erros nativos.
      req.end(input.body);
    } catch { clearTimeout(timer); fail(); }
  });
}

export class EfiPixProvider implements PixGateway {
  readonly name = 'efi' as const;
  readonly identity: string;
  readonly #config: EfiPixConfig;
  readonly #transport: EfiTransport;
  readonly #now: () => number;
  readonly #base: string;
  readonly #agent: Agent | undefined;
  #token: { value: string; expiresAt: number } | undefined;
  #authenticating: Promise<string> | undefined;

  constructor(config: EfiPixConfig, dependencies: EfiDependencies = {}) {
    requireCondition(typeof config.sandbox === 'boolean' && !!config.clientId && !!config.clientSecret && !!config.pixKey && !!config.certFile,
      'EFI_DISABLED', 'Efí desabilitada: configure client ID, client secret, chave PIX, ambiente e certificado mTLS.');
    requireCondition(!/[\r\n:]/.test(config.clientId) && !/[\r\n]/.test(config.clientSecret) && config.clientId.length <= 2048 && config.clientSecret.length <= 4096,
      'EFI_CONFIG', 'Credenciais Efí inválidas.');
    requireCondition(config.pixKey.length <= 77 && !/[\r\n]/.test(config.pixKey), 'EFI_CONFIG', 'Chave PIX Efí inválida.');
    requireCondition(config.timeoutMs === undefined || (Number.isInteger(config.timeoutMs) && config.timeoutMs >= 100 && config.timeoutMs <= 60_000), 'EFI_CONFIG', 'Timeout Efí deve ser de 100 a 60000 ms.');
    this.#config = { ...config }; this.#base = config.sandbox ? origins.sandbox : origins.production;
    this.#now = dependencies.now ?? Date.now;
    this.identity = createHash('sha256').update(JSON.stringify([this.#base, config.clientId, config.pixKey])).digest('hex');
    if (dependencies.transport) this.#transport = dependencies.transport;
    else { this.#agent = buildEfiHttpsAgent(config); this.#transport = secureTransport(this.#agent); }
  }
  close(): void { this.#token = undefined; this.#agent?.destroy(); }
  txidFor(reference: string): string { return txid(reference); }

  async #request(method: EfiHttpRequest['method'], path: string, headers: Record<string, string>, body?: Json): Promise<EfiHttpResponse> {
    requireCondition(path.startsWith('/') && !path.startsWith('//') && !path.includes('?') && !path.includes('#'), 'EFI_INVALID_PATH', 'Caminho de operação Efí inválido.');
    try {
      return await this.#transport({ method, url: new URL(path, this.#base), headers: { Accept: 'application/json', ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: this.#config.timeoutMs ?? 15_000, maxResponseBytes: bodyLimit });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('EFI_CONNECTION', 'Falha de conexão Efí. Consulte a referência antes de repetir uma escrita.');
    }
  }
  async #authorize(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.#now()) return this.#token.value;
    if (this.#authenticating) return this.#authenticating;
    const work = (async () => {
      const authorization = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64');
      const response = await this.#request('POST', '/oauth/token', { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/json' }, { grant_type: 'client_credentials' });
      if (response.status < 200 || response.status >= 300) throw new EfiHttpError(response.status);
      const data = record(response.body);
      requireCondition(typeof data.access_token === 'string' && /^[\x21-\x7e]{1,8192}$/.test(data.access_token)
        && typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0 && data.expires_in <= 86_400
        && (data.token_type === undefined || (typeof data.token_type === 'string' && data.token_type.toLowerCase() === 'bearer')),
      'EFI_AUTH_RESPONSE', 'A autenticação Efí retornou dados inválidos.');
      this.#token = { value: data.access_token, expiresAt: this.#now() + Math.max(0, data.expires_in * 1000 - Math.min(30_000, data.expires_in * 100)) };
      return data.access_token;
    })();
    this.#authenticating = work;
    try { return await work; } finally { this.#authenticating = undefined; }
  }
  async #api(method: EfiHttpRequest['method'], path: string, body?: Json): Promise<unknown> {
    const token = await this.#authorize();
    const response = await this.#request(method, path, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body);
    if (response.status === 401) this.#token = undefined;
    if (response.status < 200 || response.status >= 300) throw new EfiHttpError(response.status);
    return response.body;
  }

  async createPix(input: CreatePixInput): Promise<PixPayment> {
    const id = this.txidFor(input.reference); const original = amount(input.amountCents);
    requireCondition(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 3 && input.idempotencyKey.length <= 200, 'EFI_IDEMPOTENCY', 'Informe uma chave de operação de 3 a 200 caracteres.');
    requireCondition(input.description === undefined || (typeof input.description === 'string' && input.description.length <= 140), 'EFI_DESCRIPTION', 'A descrição Efí deve ter até 140 caracteres.');
    const expiration = input.expiresInSeconds ?? 3600;
    requireCondition(Number.isInteger(expiration) && expiration >= 60 && expiration <= 86_400, 'EFI_EXPIRATION', 'A validade da cobrança Efí deve ser de 60 a 86400 segundos.');
    // Primeiro consulta a referência estável; PUT repetido não atualiza uma cobrança existente.
    try {
      const existing = await this.getPayment(id);
      requireCondition(existing.amountCents === input.amountCents && existing.externalReference === input.reference, 'EFI_IDEMPOTENCY_CONFLICT', 'A referência Efí já possui outra cobrança.');
      return existing;
    } catch (error) { if (!(error instanceof EfiHttpError && error.status === 404)) throw error; }
    const body: Json = { calendario: { expiracao: expiration }, valor: { original }, chave: this.#config.pixKey };
    if (input.description) body.solicitacaoPagador = input.description;
    // O devedor é opcional na cobrança imediata. Não enviar CPF, nome ou email sem necessidade.
    const response = await this.#api('PUT', `/v2/cob/${id}`, body);
    const payment = await this.#normalize(response, id);
    requireCondition(payment.amountCents === input.amountCents, 'EFI_INVALID_AMOUNT', 'O valor da cobrança retornada difere do solicitado.');
    return payment;
  }
  async getPayment(id: string): Promise<PixPayment> {
    return this.#normalize(await this.#api('GET', `/v2/cob/${txid(id)}`), id);
  }

  async #normalize(raw: unknown, expected: string): Promise<PixPayment> {
    const data = record(raw);
    requireCondition(data.txid === expected, 'EFI_REFERENCE_MISMATCH', 'A cobrança Efí retornou uma referência diferente.');
    const amountCents = cents(record(data.valor).original);
    requireCondition(amountCents > 0, 'EFI_INVALID_AMOUNT', 'O valor da cobrança Efí precisa ser positivo.');
    const calendar = record(data.calendario); const created = typeof calendar.criacao === 'string' ? Date.parse(calendar.criacao) : NaN;
    requireCondition(Number.isFinite(created) && typeof calendar.expiracao === 'number' && Number.isInteger(calendar.expiracao) && calendar.expiracao > 0 && calendar.expiracao <= 86_400,
      'EFI_INVALID_RESPONSE', 'A cobrança Efí retornou um calendário inválido.');
    const expiration = created + calendar.expiracao * 1000;
    let status: PixStatus = 'unknown'; let refundedCents = 0;
    if (data.status === 'ATIVA') status = expiration <= this.#now() ? 'expired' : 'pending';
    else if (data.status === 'REMOVIDA_PELO_USUARIO_RECEBEDOR' || data.status === 'REMOVIDA_PELO_PSP') status = 'cancelled';
    else if (data.status === 'CONCLUIDA' && Array.isArray(data.pix) && data.pix.length > 0 && data.pix.length <= 100) {
      let received = 0; const seen = new Set<string>();
      for (const item of data.pix) {
        const pix = record(item);
        requireCondition(pix.txid === expected && typeof pix.endToEndId === 'string' && /^[A-Za-z0-9]{32}$/.test(pix.endToEndId) && !seen.has(pix.endToEndId), 'EFI_INVALID_RECEIPT', 'A cobrança Efí contém um recebimento inválido ou duplicado.');
        seen.add(pix.endToEndId); received += cents(pix.valor);
        refundedCents += this.#refundTotal(pix.devolucoes);
      }
      requireCondition(Number.isSafeInteger(received) && refundedCents <= received, 'EFI_INVALID_RECEIPT', 'Os recebimentos e devoluções Efí não conferem.');
      if (received === amountCents) status = refundedCents === amountCents ? 'refunded' : refundedCents > 0 ? 'unknown' : 'approved';
    }
    const payment: PixPayment = { id: expected, externalReference: expected, status, amountCents, expiresAt: new Date(expiration).toISOString(), refundedCents };
    if (status === 'pending') {
      let copy = this.#copyCode(data.pixCopiaECola);
      const location = data.loc !== undefined ? record(data.loc).id : undefined;
      if (typeof location === 'number' && Number.isSafeInteger(location) && location > 0) {
        try {
          const qr = record(await this.#api('GET', `/v2/loc/${location}/qrcode`));
          copy = this.#copyCode(qr.qrcode) ?? copy;
          const image = this.#png(qr.imagemQrcode); if (image) payment.qrCode = image;
        } catch (error) { if (!copy) throw error; }
      }
      requireCondition(copy, 'EFI_QRCODE_UNAVAILABLE', 'Cobrança criada, mas o código PIX ainda não está disponível. Consulte a referência; não gere outra cobrança.');
      payment.pixCopyPaste = copy;
    }
    return payment;
  }
  #refundTotal(raw: unknown, includePending = false): number {
    if (raw === undefined) return 0;
    requireCondition(Array.isArray(raw) && raw.length <= 100, 'EFI_INVALID_REFUND', 'Lista de devoluções Efí inválida.');
    const seen = new Set<string>(); let total = 0;
    for (const item of raw) {
      const refund = record(item);
      requireCondition(typeof refund.id === 'string' && /^[A-Za-z0-9]{1,35}$/.test(refund.id) && !seen.has(refund.id), 'EFI_INVALID_REFUND', 'Devolução Efí inválida ou duplicada.');
      seen.add(refund.id);
      if (refund.status === 'DEVOLVIDO' || (includePending && refund.status === 'EM_PROCESSAMENTO')) total += cents(refund.valor);
    }
    requireCondition(Number.isSafeInteger(total), 'EFI_INVALID_REFUND', 'O total devolvido excede o limite seguro.');
    return total;
  }
  #copyCode(value: unknown): string | undefined {
    return typeof value === 'string' && value.startsWith('000201') && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
  }
  #png(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > bodyLimit) return undefined;
    const base64 = value.replace(/^data:image\/png;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
    const decoded = Buffer.from(base64, 'base64');
    return decoded.subarray(0, 8).equals(pngHeader) ? base64 : undefined;
  }

  async getReceivedPix(endToEndId: string): Promise<{ endToEndId: string; txid?: string; amountCents: number; refundedCents: number; pendingRefundCents: number }> {
    requireCondition(/^[A-Za-z0-9]{32}$/.test(endToEndId), 'EFI_INVALID_RECEIPT', 'Identificador end-to-end Efí inválido.');
    const data = record(await this.#api('GET', `/v2/pix/${endToEndId}`));
    requireCondition(data.endToEndId === endToEndId && (data.txid === undefined || (typeof data.txid === 'string' && txid(data.txid))), 'EFI_INVALID_RECEIPT', 'A API Efí retornou outro recebimento.');
    const amountCents = cents(data.valor); const refundedCents = this.#refundTotal(data.devolucoes);
    const committedRefundCents = this.#refundTotal(data.devolucoes, true);
    requireCondition(committedRefundCents <= amountCents, 'EFI_INVALID_REFUND', 'O valor devolvido ou reservado para devolução excede o recebimento.');
    return { endToEndId, ...(typeof data.txid === 'string' ? { txid: data.txid } : {}), amountCents, refundedCents, pendingRefundCents: committedRefundCents - refundedCents };
  }
  async getRefund(endToEndId: string, id: string): Promise<EfiRefund> {
    this.#validateRefundIds(endToEndId, id);
    return this.#normalizeRefund(await this.#api('GET', `/v2/pix/${endToEndId}/devolucao/${id}`), endToEndId, id);
  }
  async refundPix(endToEndId: string, id: string, amountCents: number): Promise<EfiRefund> {
    this.#validateRefundIds(endToEndId, id); const value = amount(amountCents);
    try {
      const existing = await this.getRefund(endToEndId, id);
      requireCondition(existing.amountCents === amountCents, 'EFI_IDEMPOTENCY_CONFLICT', 'A referência de devolução já foi utilizada com outro valor.');
      return existing;
    } catch (error) { if (!(error instanceof EfiHttpError && error.status === 404)) throw error; }
    const received = await this.getReceivedPix(endToEndId);
    requireCondition(amountCents <= received.amountCents - received.refundedCents - received.pendingRefundCents, 'EFI_REFUND_LIMIT', 'O valor solicitado excede o recebimento ainda disponível para devolução.');
    const result = this.#normalizeRefund(await this.#api('PUT', `/v2/pix/${endToEndId}/devolucao/${id}`, { valor: value }), endToEndId, id);
    requireCondition(result.amountCents === amountCents, 'EFI_INVALID_REFUND', 'O valor da devolução Efí difere do solicitado.');
    return result;
  }
  #validateRefundIds(endToEndId: string, id: string): void {
    requireCondition(/^[A-Za-z0-9]{32}$/.test(endToEndId) && /^[A-Za-z0-9]{1,35}$/.test(id), 'EFI_INVALID_REFUND', 'Identificadores de recebimento ou devolução Efí inválidos.');
  }
  #normalizeRefund(raw: unknown, endToEndId: string, id: string): EfiRefund {
    const data = record(raw); requireCondition(data.id === id, 'EFI_INVALID_REFUND', 'A API retornou outra devolução.');
    const status = data.status === 'DEVOLVIDO' ? 'refunded' : data.status === 'EM_PROCESSAMENTO' ? 'pending' : data.status === 'NAO_REALIZADO' ? 'rejected' : 'unknown';
    return { id, endToEndId, amountCents: cents(data.valor), status };
  }
}
