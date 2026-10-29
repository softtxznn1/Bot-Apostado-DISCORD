import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { DomainError } from './domain.js';
import {
  parseMercadoPagoWebhookRequest,
  type MercadoPagoPixProvider,
  type MercadoPagoWebhookInput,
  type MercadoPagoWebhookVerification,
} from './payment-providers/mercadopago.js';
import type { PixPayment } from './payment-providers/types.js';

export type PaymentWebhookOptions = {
  mercadoPago: Pick<MercadoPagoPixProvider, 'verifyWebhook' | 'canonicalPaymentFromWebhook'>;
  /** Validar vínculo, conta, valor e referência antes de conciliar qualquer recebimento. */
  onMercadoPagoPayment(payment: PixPayment): Promise<void>;
  rateLimit?: number;
  now?: () => number;
  dedupTtlMs?: number;
};

class WebhookHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const CAPACITY = 1000;
const MAX_BODY = 16_384;

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function consumeBody(request: IncomingMessage): Promise<void> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw new WebhookHttpError(413, 'Notificação excede o tamanho permitido.');
  }
  const text = await new Promise<string>((resolve, reject) => {
    let size = 0; let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: WebhookHttpError) => {
      if (settled) return;
      settled = true; chunks.length = 0; reject(error);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) { fail(new WebhookHttpError(413, 'Notificação excede o tamanho permitido.')); return; }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true; resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('aborted', () => fail(new WebhookHttpError(400, 'Notificação interrompida.')));
    request.once('error', () => fail(new WebhookHttpError(400, 'Notificação interrompida.')));
  });
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
  } catch { throw new WebhookHttpError(400, 'Corpo da notificação inválido.'); }
  // Não retornar status, valor ou ID do corpo. A origem de verdade é o GET canônico.
}

/**
 * Receptor isolado. Não registra pagamentos usando o corpo de um webhook.
 * Verifica HMAC, consulta o provedor e entrega o resultado canônico ao conciliador.
 */
export function createPaymentWebhookServer(options: PaymentWebhookOptions): Server {
  const rateLimit = options.rateLimit ?? 300;
  const ttl = options.dedupTtlMs ?? 300_000;
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10_000
    || !Number.isInteger(ttl) || ttl < 1000 || ttl > 900_000) {
    throw new DomainError('WEBHOOK_CONFIG', 'Limites do receptor de webhook inválidos.');
  }
  const now = options.now ?? Date.now;
  const rates = new Map<string, { start: number; count: number }>();
  const completed = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();

  function rate(peer: string): void {
    const timestamp = now();
    const current = rates.get(peer);
    if (current && timestamp - current.start < 60_000) {
      current.count++;
      if (current.count > rateLimit) throw new WebhookHttpError(429, 'Limite de notificações atingido. Tente novamente mais tarde.');
      return;
    }
    if (rates.size >= CAPACITY) {
      for (const [key, entry] of rates) if (timestamp - entry.start >= 60_000) rates.delete(key);
    }
    if (!current && rates.size >= CAPACITY) throw new WebhookHttpError(503, 'Receptor temporariamente ocupado.');
    rates.set(peer, { start: timestamp, count: 1 });
  }

  async function process(input: MercadoPagoWebhookInput, verified: MercadoPagoWebhookVerification): Promise<boolean> {
    for (const [key, expires] of completed) if (expires <= now()) completed.delete(key);
    const key = createHash('sha256').update(JSON.stringify([verified.paymentId, verified.requestId, verified.timestamp])).digest('hex');
    if (completed.has(key)) return true;
    const existing = pending.get(key);
    if (existing) { await existing; return true; }
    if (pending.size >= CAPACITY) throw new WebhookHttpError(503, 'Receptor temporariamente ocupado.');
    const task = (async () => {
      const payment = await options.mercadoPago.canonicalPaymentFromWebhook(input);
      if (!payment || payment.id !== verified.paymentId) throw new WebhookHttpError(503, 'Não foi possível confirmar a notificação no provedor.');
      await options.onMercadoPagoPayment(payment);
      if (completed.size >= CAPACITY) completed.delete(completed.keys().next().value!);
      completed.set(key, now() + ttl);
    })();
    pending.set(key, task);
    try { await task; }
    finally { pending.delete(key); }
    return false;
  }

  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    void (async () => {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new WebhookHttpError(400, 'Destino da notificação inválido.');
      let url: URL;
      try { url = new URL(request.url, 'http://webhook.invalid'); }
      catch { throw new WebhookHttpError(400, 'Destino da notificação inválido.'); }
      if (url.pathname !== '/webhooks/mercadopago') throw new WebhookHttpError(404, 'Rota não encontrada.');
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST'); throw new WebhookHttpError(405, 'Método não permitido.');
      }
      if (request.rawHeaders.length > 80) throw new WebhookHttpError(431, 'Cabeçalhos excedem o limite permitido.');
      rate(request.socket.remoteAddress ?? 'unknown');
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new WebhookHttpError(415, 'Envie application/json.');
      }
      let input: MercadoPagoWebhookInput;
      try { input = parseMercadoPagoWebhookRequest(request.rawHeaders, request.url); }
      catch { throw new WebhookHttpError(400, 'Cabeçalhos ou identificadores da notificação inválidos.'); }
      let verified: MercadoPagoWebhookVerification;
      try { verified = options.mercadoPago.verifyWebhook(input); }
      catch (error) {
        if (error instanceof DomainError && error.code === 'MP_WEBHOOK_CONFIG') throw new WebhookHttpError(503, 'Receptor de notificações ainda não configurado.');
        throw new WebhookHttpError(401, 'Assinatura da notificação inválida.');
      }
      await consumeBody(request);
      const duplicate = await process(input, verified);
      reply(response, 200, { received: true, duplicate });
    })().catch((error: unknown) => {
      request.resume();
      const status = error instanceof WebhookHttpError ? error.status : 503;
      if (status === 429 || status === 503) response.setHeader('Retry-After', status === 429 ? '60' : '30');
      // Não serializar erros de SDK, respostas HTTP, cabeçalhos ou chaves.
      reply(response, status, { error: error instanceof WebhookHttpError ? error.message : 'Não foi possível conciliar a notificação. Tente novamente mais tarde.' });
    });
  });
  server.maxConnections = 256;
  server.maxHeadersCount = 40;
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const overflow = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW';
    socket.end(`HTTP/1.1 ${overflow ? '431 Request Header Fields Too Large' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.once('close', () => { rates.clear(); completed.clear(); });
  return server;
}
