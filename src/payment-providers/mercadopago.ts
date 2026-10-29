import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { DomainError, requireCondition } from '../domain.js';
import type { CreatePixInput, PixPayment, PixStatus } from './types.js';

export type MercadoPagoPayment = PixPayment & { refundedCents: number };
export type MercadoPagoRefund = { id: string; paymentId: string; status: 'approved' | 'pending' | 'unknown'; amountCents: number };
export type MercadoPagoWebhookInput = {
  signature: string | readonly string[] | null | undefined;
  requestId: string | readonly string[] | null | undefined;
  dataId: string | readonly string[] | null | undefined;
};
export type MercadoPagoWebhookVerification = { paymentId: string; requestId: string; timestamp: string };
export type MercadoPagoOptions = {
  accessToken: string; webhookSecret?: string; timeoutMs?: number; now?: () => number;
  /** Exclusivamente para testes locais: HTTP literal 127.0.0.1 ou [::1], sem caminhos. */
  testBaseUrl?: string;
};

export class MercadoPagoProviderError extends DomainError {
  constructor(code: string, message: string, public readonly outcome: 'not_created' | 'unknown' | 'read_failed', public readonly httpStatus?: number) {
    super(code, message);
    this.name = 'MercadoPagoProviderError';
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_AMOUNT_CENTS = 99_999_999;
const paymentIdPattern = /^[1-9]\d{0,29}$/;

function validPaymentId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  requireCondition(typeof id === 'string' && paymentIdPattern.test(id), 'MP_INVALID_PAYMENT_ID', 'ID de pagamento Mercado Pago inválido.');
  return id;
}
function stableKey(value: string): string {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(value), 'MP_INVALID_KEY', 'A chave de idempotência deve conter de 8 a 64 letras, números, ponto, _, : ou -.');
  return value;
}
function cents(value: unknown, allowZero = false): number {
  requireCondition(typeof value === 'number' && Number.isFinite(value), 'MP_INVALID_RESPONSE', 'Valor monetário inválido na resposta Mercado Pago.');
  const parts = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(String(value));
  requireCondition(parts, 'MP_INVALID_RESPONSE', 'A resposta monetária Mercado Pago não representa centavos exatos.');
  const result = Number(parts[1]) * 100 + Number((parts[2] ?? '').padEnd(2, '0'));
  requireCondition(result <= MAX_AMOUNT_CENTS && (allowZero ? result >= 0 : result > 0), 'MP_INVALID_RESPONSE', 'Valor monetário fora do limite da aplicação.');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'MP_INVALID_RESPONSE', 'Resposta Mercado Pago inválida.');
  return value as Record<string, unknown>;
}
function normalizePayment(payload: unknown): MercadoPagoPayment {
  const data = object(payload);
  const id = validPaymentId(data.id);
  requireCondition(data.currency_id === 'BRL' && data.payment_method_id === 'pix', 'MP_INVALID_RESPONSE', 'O pagamento consultado precisa ser PIX em BRL.');
  requireCondition(typeof data.external_reference === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(data.external_reference), 'MP_INVALID_RESPONSE', 'Referência externa ausente ou inválida no pagamento.');
  const amountCents = cents(data.transaction_amount);
  const refundedCents = data.transaction_amount_refunded == null ? 0 : cents(data.transaction_amount_refunded, true);
  requireCondition(refundedCents <= amountCents, 'MP_INVALID_RESPONSE', 'Estorno maior que o pagamento na resposta Mercado Pago.');
  const map: Record<string, PixStatus> = {
    approved: 'approved', pending: 'pending', authorized: 'pending', in_process: 'pending',
    in_mediation: 'pending', rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded',
  };
  const status = typeof data.status === 'string' ? map[data.status] ?? 'unknown' : 'unknown';
  let expiresAt: string | undefined;
  if (data.date_of_expiration != null) {
    requireCondition(typeof data.date_of_expiration === 'string' && Number.isFinite(Date.parse(data.date_of_expiration)), 'MP_INVALID_RESPONSE', 'Validade do PIX inválida na resposta Mercado Pago.');
    expiresAt = new Date(data.date_of_expiration).toISOString();
  }
  let qrCode: string | undefined; let pixCopyPaste: string | undefined;
  if (data.point_of_interaction != null) {
    const interaction = object(data.point_of_interaction);
    if (interaction.transaction_data != null) {
      const transaction = object(interaction.transaction_data);
      if (transaction.qr_code != null) {
        requireCondition(typeof transaction.qr_code === 'string' && transaction.qr_code.length > 0 && transaction.qr_code.length <= 8192 && !/[\x00-\x1f\x7f]/.test(transaction.qr_code), 'MP_INVALID_RESPONSE', 'Código PIX inválido na resposta Mercado Pago.');
        pixCopyPaste = transaction.qr_code;
      }
      if (transaction.qr_code_base64 != null) {
        requireCondition(typeof transaction.qr_code_base64 === 'string' && transaction.qr_code_base64.length > 0 && transaction.qr_code_base64.length <= 750_000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(transaction.qr_code_base64), 'MP_INVALID_RESPONSE', 'Imagem QR inválida na resposta Mercado Pago.');
        const png = Buffer.from(transaction.qr_code_base64, 'base64');
        requireCondition(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'MP_INVALID_RESPONSE', 'A imagem QR retornada não é PNG.');
        qrCode = transaction.qr_code_base64;
      }
    }
  }
  return { id, status, amountCents, refundedCents, externalReference: data.external_reference, qrCode, pixCopyPaste, expiresAt };
}

function one(value: MercadoPagoWebhookInput['signature'], label: string): string {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n]/.test(value), 'MP_INVALID_WEBHOOK', `Cabeçalho ou identificador ${label} ausente, duplicado ou inválido.`);
  return value.trim();
}

/** Assinatura v1 oficial. Status do corpo NÃO é fonte de verdade. */
export function verifyMercadoPagoWebhook(input: MercadoPagoWebhookInput & { secret: string; toleranceSeconds?: number; now?: () => number }): MercadoPagoWebhookVerification {
  requireCondition(typeof input.secret === 'string' && input.secret.length >= 16 && input.secret.length <= 4096 && !/[\r\n]/.test(input.secret), 'MP_WEBHOOK_CONFIG', 'Configure um segredo de webhook Mercado Pago separado do access token.');
  const signature = one(input.signature, 'x-signature');
  const requestId = one(input.requestId, 'x-request-id');
  const paymentId = one(input.dataId, 'data.id');
  requireCondition(/^[A-Za-z0-9._:-]{1,200}$/.test(requestId) && paymentIdPattern.test(paymentId), 'MP_INVALID_WEBHOOK', 'Identificadores da notificação Mercado Pago inválidos.');
  const parsed = new Map<string, string>();
  for (const part of signature.split(',')) {
    const field = /^\s*([A-Za-z0-9]+)=([^=]+?)\s*$/.exec(part);
    requireCondition(field, 'MP_INVALID_WEBHOOK', 'Assinatura Mercado Pago malformada.');
    const key = field[1]!.toLowerCase(); const value = field[2]!.trim();
    requireCondition((key === 'ts' || /^v\d+$/.test(key)) && !parsed.has(key), 'MP_INVALID_WEBHOOK', 'Campos de assinatura Mercado Pago duplicados ou desconhecidos.');
    parsed.set(key, value);
  }
  const timestamp = parsed.get('ts'); const hash = parsed.get('v1');
  requireCondition(timestamp && /^[1-9]\d{8,15}$/.test(timestamp) && hash && /^[a-fA-F0-9]{64}$/.test(hash), 'MP_INVALID_WEBHOOK', 'A assinatura precisa conter ts e um hash v1 SHA-256 válidos.');
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  requireCondition(Number.isInteger(toleranceSeconds) && toleranceSeconds > 0 && toleranceSeconds <= 900, 'MP_WEBHOOK_CONFIG', 'A tolerância do webhook deve ser de 1 a 900 segundos.');
  const numericTimestamp = Number(timestamp);
  requireCondition(Number.isSafeInteger(numericTimestamp), 'MP_INVALID_WEBHOOK', 'Timestamp de assinatura inválido.');
  // Mantém o valor original no manifesto; aceita timestamps em segundos e o formato legado em ms.
  const timestampMs = timestamp.length >= 13 ? numericTimestamp : numericTimestamp * 1000;
  requireCondition(Math.abs((input.now ?? Date.now)() - timestampMs) <= toleranceSeconds * 1000, 'MP_INVALID_WEBHOOK', 'Notificação Mercado Pago fora da janela de validade.');
  const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
  const expected = createHmac('sha256', input.secret).update(manifest).digest();
  requireCondition(timingSafeEqual(expected, Buffer.from(hash, 'hex')), 'MP_INVALID_WEBHOOK', 'Assinatura Mercado Pago não confere.');
  return { paymentId, requestId, timestamp };
}

/** Usa headers brutos e query completa para rejeitar duplicatas ocultadas pelo framework/proxy. */
export function parseMercadoPagoWebhookRequest(rawHeaders: readonly string[], requestUrl: string): MercadoPagoWebhookInput {
  requireCondition(rawHeaders.length % 2 === 0, 'MP_INVALID_WEBHOOK', 'Lista de cabeçalhos inválida.');
  const signature: string[] = []; const requestId: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase(); const value = rawHeaders[i + 1]!;
    if (name === 'x-signature') signature.push(value);
    if (name === 'x-request-id') requestId.push(value);
  }
  let ids: string[];
  try { ids = new URL(requestUrl, 'https://webhook.invalid').searchParams.getAll('data.id'); }
  catch { throw new DomainError('MP_INVALID_WEBHOOK', 'URL de notificação inválida.'); }
  requireCondition(signature.length === 1 && requestId.length === 1 && ids.length === 1, 'MP_INVALID_WEBHOOK', 'Notificação precisa de x-signature, x-request-id e data.id únicos.');
  return { signature: signature[0]!, requestId: requestId[0]!, dataId: ids[0]! };
}

export class MercadoPagoPixProvider {
  readonly name = 'mercadopago' as const;
  readonly identity = 'mercadopago-pix-v1';
  #accessToken: string; #webhookSecret: string | undefined; #baseUrl: string;
  #timeoutMs: number; #now: () => number;

  constructor(options: MercadoPagoOptions) {
    requireCondition(typeof options.accessToken === 'string' && options.accessToken.trim().length > 0 && options.accessToken.length <= 4096 && !/[\r\n]/.test(options.accessToken), 'MP_CONFIG', 'Configure o access token privado Mercado Pago.');
    this.#accessToken = options.accessToken; this.#webhookSecret = options.webhookSecret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    requireCondition(Number.isInteger(this.#timeoutMs) && this.#timeoutMs >= 100 && this.#timeoutMs <= 30_000, 'MP_CONFIG', 'Timeout Mercado Pago deve ser de 100 a 30000 ms.');
    this.#now = options.now ?? Date.now;
    this.#baseUrl = 'https://api.mercadopago.com';
    if (options.testBaseUrl !== undefined) {
      let local: URL;
      try { local = new URL(options.testBaseUrl); } catch { throw new DomainError('MP_CONFIG', 'URL de teste Mercado Pago inválida.'); }
      requireCondition(local.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(local.hostname) && !local.username && !local.password && local.pathname === '/' && !local.search && !local.hash, 'MP_CONFIG', 'testBaseUrl aceita somente uma origem HTTP literal de loopback, sem credenciais ou caminho.');
      this.#baseUrl = local.origin;
    }
  }

  [inspect.custom](): string { return 'MercadoPagoPixProvider { credentials: [REDACTED] }'; }

  async #request(path: string, method: 'GET' | 'POST', body?: unknown, key?: string): Promise<unknown> {
    const writing = method === 'POST';
    const failure = (status?: number): MercadoPagoProviderError => new MercadoPagoProviderError(
      writing ? 'PAYMENT_WRITE_UNCERTAIN' : 'PAYMENT_READ_FAILED',
      writing ? 'A resposta Mercado Pago é incerta. Consulte a operação antes de repetir com a mesma chave persistida.' : 'Não foi possível consultar o pagamento Mercado Pago.',
      writing ? 'unknown' : 'read_failed', status,
    );
    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${this.#accessToken}`, Accept: 'application/json', ...(writing ? { 'Content-Type': 'application/json', 'X-Idempotency-Key': key! } : {}) },
        body: writing ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (writing && [400, 401, 403, 404, 422].includes(response.status)) throw new MercadoPagoProviderError('PAYMENT_NOT_CREATED', 'Mercado Pago rejeitou a operação. Verifique configuração e dados sem repetir automaticamente.', 'not_created', response.status);
        throw failure(response.status);
      }
      if (!(Number(response.headers.get('content-length') ?? 0) <= MAX_RESPONSE_BYTES)) {
        await response.body?.cancel();
        throw failure();
      }
      requireCondition(response.body, 'MP_INVALID_RESPONSE', 'Mercado Pago retornou uma resposta vazia.');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          requireCondition(size <= MAX_RESPONSE_BYTES, 'MP_RESPONSE_TOO_LARGE', 'Resposta Mercado Pago excedeu o limite de tamanho.');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof MercadoPagoProviderError) throw error;
      // Não expor erro original, URL, cabeçalhos, corpo ou credenciais.
      throw failure();
    }
  }

  async createPix(input: CreatePixInput): Promise<MercadoPagoPayment> {
    requireCondition(typeof input.reference === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.reference), 'MP_INVALID_REFERENCE', 'Use uma referência externa interna de até 128 caracteres, sem dados pessoais.');
    stableKey(input.idempotencyKey);
    requireCondition(Number.isSafeInteger(input.amountCents) && input.amountCents > 0 && input.amountCents <= MAX_AMOUNT_CENTS, 'MP_INVALID_AMOUNT', 'O valor PIX precisa ter de 1 a 99999999 centavos.');
    requireCondition(typeof input.payerEmail === 'string' && input.payerEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.payerEmail), 'MP_INVALID_PAYER', 'Configure um e-mail válido para o pagador. E-mail não comprova pagamento.');
    requireCondition(input.description === undefined || (input.description.length > 0 && input.description.length <= 200 && !/[\x00-\x1f\x7f]/.test(input.description)), 'MP_INVALID_DESCRIPTION', 'A descrição deve ter até 200 caracteres sem controles.');
    requireCondition(input.expiresInSeconds === undefined || (Number.isInteger(input.expiresInSeconds) && input.expiresInSeconds >= 1 && input.expiresInSeconds <= 2_592_000), 'MP_INVALID_EXPIRATION', 'Validade PIX inválida.');
    const body = {
      transaction_amount: input.amountCents / 100, payment_method_id: 'pix', external_reference: input.reference,
      description: input.description ?? 'Pagamento de partida', payer: { email: input.payerEmail },
      ...(input.expiresInSeconds === undefined ? {} : { date_of_expiration: new Date(this.#now() + input.expiresInSeconds * 1000).toISOString() }),
    };
    const payload = await this.#request('/v1/payments', 'POST', body, input.idempotencyKey);
    try {
      const payment = normalizePayment(payload);
      requireCondition(payment.externalReference === input.reference && payment.amountCents === input.amountCents, 'MP_PAYMENT_MISMATCH', 'A resposta não corresponde à cobrança solicitada.');
      requireCondition(payment.status !== 'pending' || !!payment.pixCopyPaste, 'MP_INVALID_RESPONSE', 'Pagamento PIX pendente sem código de pagamento.');
      return payment;
    } catch { throw new MercadoPagoProviderError('PAYMENT_WRITE_UNCERTAIN', 'A resposta da criação PIX não pôde ser validada. Consulte a operação antes de repetir.', 'unknown'); }
  }
  async getPayment(id: string): Promise<MercadoPagoPayment> {
    validPaymentId(id);
    const payload = await this.#request(`/v1/payments/${id}`, 'GET');
    try {
      const payment = normalizePayment(payload);
      requireCondition(payment.id === id, 'MP_PAYMENT_MISMATCH', 'Consulta Mercado Pago retornou outro pagamento.');
      return payment;
    } catch { throw new MercadoPagoProviderError('PAYMENT_READ_FAILED', 'A resposta da consulta Mercado Pago não pôde ser validada.', 'read_failed'); }
  }
  /** Lookup após resposta perdida; ausência na busca NÃO prova que a criação não ocorreu. */
  async findPaymentByReference(reference: string): Promise<MercadoPagoPayment | undefined> {
    requireCondition(typeof reference === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(reference), 'MP_INVALID_REFERENCE', 'Referência externa inválida.');
    const query = new URLSearchParams({ external_reference: reference, limit: '2', sort: 'date_created', criteria: 'desc' });
    const payload = await this.#request(`/v1/payments/search?${query}`, 'GET');
    let id: string;
    try {
      const data = object(payload); const paging = object(data.paging);
      requireCondition(Array.isArray(data.results) && Number.isInteger(paging.total) && Number(paging.total) >= 0, 'MP_INVALID_RESPONSE', 'Resposta de busca inválida.');
      if (paging.total === 0 && data.results.length === 0) return undefined;
      requireCondition(paging.total === 1 && data.results.length === 1, 'MP_AMBIGUOUS_REFERENCE', 'Mais de um pagamento ou resultado incompleto para a referência.');
      const result = object(data.results[0]);
      requireCondition(result.external_reference === reference, 'MP_PAYMENT_MISMATCH', 'A busca retornou outra referência.');
      id = validPaymentId(result.id);
    } catch { throw new MercadoPagoProviderError('PAYMENT_LOOKUP_AMBIGUOUS', 'A busca de referência não pôde ser validada de forma única. Mantenha a operação pendente para reconciliação.', 'read_failed'); }
    const payment = await this.getPayment(id);
    requireCondition(payment.externalReference === reference, 'MP_PAYMENT_MISMATCH', 'A consulta canônica retornou outra referência.');
    return payment;
  }
  async refundPayment(id: string, idempotencyKey: string): Promise<MercadoPagoRefund> {
    validPaymentId(id); stableKey(idempotencyKey);
    const payment = await this.getPayment(id);
    requireCondition(payment.status === 'approved' && payment.refundedCents === 0, 'MP_NOT_REFUNDABLE', 'O estorno integral exige pagamento aprovado sem estorno anterior. Consulte os estornos existentes antes de repetir.');
    const payload = await this.#request(`/v1/payments/${id}/refunds`, 'POST', {}, idempotencyKey);
    try {
      const data = object(payload); const refundId = validPaymentId(data.id); const paymentId = validPaymentId(data.payment_id);
      const amountCents = cents(data.amount);
      requireCondition(paymentId === id && amountCents === payment.amountCents, 'MP_REFUND_MISMATCH', 'Estorno Mercado Pago não corresponde ao pagamento integral.');
      return { id: refundId, paymentId, amountCents, status: data.status === 'approved' ? 'approved' : data.status === 'in_process' || data.status === 'pending' ? 'pending' : 'unknown' };
    } catch { throw new MercadoPagoProviderError('PAYMENT_WRITE_UNCERTAIN', 'A resposta do estorno não pôde ser validada. Consulte o pagamento antes de repetir.', 'unknown'); }
  }
  verifyWebhook(input: MercadoPagoWebhookInput): MercadoPagoWebhookVerification {
    return verifyMercadoPagoWebhook({ ...input, secret: this.#webhookSecret ?? '', now: this.#now });
  }
  async canonicalPaymentFromWebhook(input: MercadoPagoWebhookInput): Promise<MercadoPagoPayment> {
    const verified = this.verifyWebhook(input);
    return this.getPayment(verified.paymentId);
  }
}
