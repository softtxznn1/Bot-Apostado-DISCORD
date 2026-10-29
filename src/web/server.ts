import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { BotService } from '../service.js';
import { DomainError, TERMINAL, type Match } from '../domain.js';
import { OperationsService } from '../operations.js';
import { PaymentsService } from '../payments.js';
import { dashboardPage, dashboardCss, dashboardJs, loginPage } from './dashboard.js';

export type DashboardOptions = {
  token: string;
  allowedGuildIds?: readonly string[];
  allowedHosts?: readonly string[];
  secureCookies?: boolean;
  sessionTtlMs?: number;
  rateLimit?: number;
  loginRateLimit?: number;
  now?: () => number;
};
type Session = { csrf: string; expires: number };
type Auth = { type: 'bearer' } | { type: 'session'; id: string; session: Session };
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const constantEqual = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
};
const html = (response: ServerResponse, status: number, value: string): void => {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(value);
};

function safeMatch(match: Match) {
  return {
    id: match.id, guildId: match.guildId, state: match.state, teamSize: match.teamSize,
    platform: match.platform, rules: match.rules, stakeCents: match.stakeCents,
    createdAt: match.createdAt, expiresAt: match.expiresAt, mediatorId: match.mediatorId,
    players: match.players.map(p => ({ userId: p.userId, team: p.team, confirmed: p.confirmed })),
    result: match.result ? { winner: match.result.decision?.winner ?? match.result.winner, proposedWinner: match.result.winner, proposedScore: match.result.score, moderationDecision: !!match.result.decision } : null,
    roomSource: match.room?.source ?? null,
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const max = 16_384;
  if (Number(request.headers['content-length']) > max) { request.resume(); throw new HttpError(413, 'Corpo da requisição muito grande.'); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    request.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) { failed = true; chunks.length = 0; reject(new HttpError(413, 'Corpo da requisição muito grande.')); return; }
      chunks.push(chunk);
    });
    request.once('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    request.once('error', () => { if (!failed) reject(new HttpError(400, 'Requisição interrompida.')); });
  });
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Envie application/json.');
  try {
    const value: unknown = JSON.parse(await body(request));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Objeto JSON inválido.');
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON inválido.'); }
}
function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 300) throw new HttpError(400, `${label} inválido.`);
  return value;
}

export function createDashboardServer(service: BotService, options: DashboardOptions): Server {
  if (!options.token || options.token.length < 24 || options.token.length > 512) throw new DomainError('DASHBOARD_CONFIG', 'DASHBOARD_TOKEN precisa ter de 24 a 512 caracteres.');
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 30 * 60_000;
  if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 86_400_000) throw new DomainError('DASHBOARD_CONFIG', 'Prazo de sessão inválido.');
  const allowedGuilds = options.allowedGuildIds ? new Set(options.allowedGuildIds) : undefined;
  const hosts = new Set(options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]']);
  for (const limit of [options.rateLimit, options.loginRateLimit]) if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) throw new DomainError('DASHBOARD_CONFIG', 'Limite de requisições inválido.');
  const sessions = new Map<string, Session>();
  const rates = new Map<string, { start: number; count: number }>();
  const actor = { userId: 'dashboard-operator', moderator: true, mediator: false };
  const operations = new OperationsService(service.store, service, now);
  const payments = new PaymentsService(service.store, service, now);
  const cookie = (id: string, expires = false): string => `ffops_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expires ? 0 : Math.floor(ttl / 1000)}${options.secureCookies ? '; Secure' : ''}`;

  function rate(key: string, limit: number): void {
    const timestamp = now();
    if (rates.size > 10_000) for (const [id, item] of rates) if (timestamp - item.start > 60_000) rates.delete(id);
    const entry = rates.get(key);
    if (!entry || timestamp - entry.start >= 60_000) { rates.set(key, { start: timestamp, count: 1 }); return; }
    entry.count++;
    if (entry.count > limit) throw new HttpError(429, 'Muitas requisições. Aguarde um minuto.');
  }
  function authenticate(request: IncomingMessage): Auth | undefined {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      return constantEqual(authorization.slice(7), options.token) ? { type: 'bearer' } : undefined;
    }
    const id = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ffops_session='))?.slice('ffops_session='.length);
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expires <= now()) { sessions.delete(id); return undefined; }
    return { type: 'session', id, session };
  }
  function guild(value: unknown): string {
    const id = stringField(value, 'Servidor');
    if ((allowedGuilds && !allowedGuilds.has(id)) || !service.config(id)) throw new HttpError(404, 'Servidor não encontrado neste painel.');
    return id;
  }
  function origin(request: IncomingMessage): void {
    const value = request.headers.origin;
    if (!value) return;
    try {
      const candidate = new URL(value);
      if (!['http:', 'https:'].includes(candidate.protocol) || candidate.host !== request.headers.host) throw new Error('origin');
    } catch { throw new HttpError(403, 'Origem não permitida.'); }
  }
  function mutation(request: IncomingMessage, auth: Auth): void {
    origin(request);
    if (auth.type === 'session') {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !constantEqual(csrf, auth.session.csrf)) throw new HttpError(403, 'Confirmação da sessão ausente ou inválida.');
    }
  }

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    void (async () => {
      const host = request.headers.host;
      let hostname: string | undefined;
      try { if (host && !host.includes('@')) hostname = new URL(`http://${host}`).hostname; } catch { /* Host inválido é rejeitado abaixo. */ }
      if (!hostname || !hosts.has(hostname)) throw new HttpError(403, 'Host não permitido.');
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.searchParams.has('token') || url.searchParams.has('access_token')) throw new HttpError(400, 'Não envie credenciais pela URL.');
      rate(request.socket.remoteAddress ?? 'unknown', options.rateLimit ?? 180);
      for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id);
      if (request.method === 'GET' && url.pathname === '/assets/style.css') {
        response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); response.end(dashboardCss); return;
      }
      if (request.method === 'GET' && url.pathname === '/login') { html(response, 200, loginPage()); return; }
      if (request.method === 'POST' && url.pathname === '/login') {
        origin(request); rate(`login:${request.socket.remoteAddress ?? 'unknown'}`, options.loginRateLimit ?? 8);
        const text = await body(request);
        let candidate: unknown;
        if (request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          try { candidate = (JSON.parse(text) as { token?: unknown }).token; } catch { throw new HttpError(400, 'JSON inválido.'); }
        } else if (request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) candidate = new URLSearchParams(text).get('token');
        else throw new HttpError(415, 'Formato de autenticação inválido.');
        if (typeof candidate !== 'string' || !constantEqual(candidate, options.token)) { html(response, 401, loginPage(true)); return; }
        if (sessions.size >= 500) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { csrf: randomBytes(32).toString('hex'), expires: now() + ttl });
        response.setHeader('Set-Cookie', cookie(id)); response.writeHead(303, { Location: '/' }); response.end(); return;
      }
      const auth = authenticate(request);
      if (!auth) {
        if (url.pathname === '/') { response.writeHead(303, { Location: '/login' }); response.end(); }
        else json(response, 401, { error: 'Autenticação necessária.' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') { html(response, 200, dashboardPage); return; }
      if (request.method === 'GET' && url.pathname === '/assets/app.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(dashboardJs); return;
      }
      if (request.method === 'POST') mutation(request, auth);
      if (request.method === 'POST' && url.pathname === '/logout') {
        if (auth.type === 'session') sessions.delete(auth.id);
        response.setHeader('Set-Cookie', cookie('', true)); json(response, 200, { ok: true }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, { csrf: auth.type === 'session' ? auth.session.csrf : null }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/guilds') {
        const rows = service.store.db.prepare('SELECT guild_id FROM guilds ORDER BY guild_id').all() as { guild_id: string }[];
        json(response, 200, rows.filter(r => !allowedGuilds || allowedGuilds.has(r.guild_id)).map(r => ({ guildId: r.guild_id }))); return;
      }
      if (request.method === 'GET' && ['/api/overview', '/api/matches', '/api/queues', '/api/ranking', '/api/audit', '/api/config', '/api/operations', '/api/finance'].includes(url.pathname)) {
        const id = guild(url.searchParams.get('guildId'));
        const matches = service.matches(id);
        if (url.pathname === '/api/overview') {
          const queued = service.store.db.prepare('SELECT COUNT(*) AS count FROM reservations WHERE guild_id=? AND queue_id IS NOT NULL').get(id) as { count: number };
          json(response, 200, { activeMatches: matches.filter(m => !TERMINAL.has(m.state)).length, disputedMatches: matches.filter(m => m.state === 'disputed').length, finishedMatches: matches.filter(m => m.state === 'finished').length, queuedPlayers: queued.count }); return;
        }
        if (url.pathname === '/api/matches') {
          const state = url.searchParams.get('state') ?? '';
          json(response, 200, matches.filter(m => !state || (state === 'active' ? !TERMINAL.has(m.state) : m.state === state)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map(safeMatch)); return;
        }
        if (url.pathname === '/api/queues') {
          const queues = service.store.db.prepare('SELECT id,team_size,platform,rules,stake_cents FROM queues WHERE guild_id=? ORDER BY id').all(id) as { id: string; team_size: number; platform: string; rules: string; stake_cents: number }[];
          json(response, 200, queues.map(q => ({ id: q.id, teamSize: q.team_size, platform: q.platform, rules: q.rules, stakeCents: q.stake_cents, queuedPlayers: service.queuePlayers(id, q.id).length }))); return;
        }
        if (url.pathname === '/api/ranking') { json(response, 200, service.ranking(id).slice(0, 100)); return; }
        if (url.pathname === '/api/operations') {
          json(response, 200, {
            tickets: operations.tickets(id, actor).map(t => ({ id: t.id, ownerId: t.ownerId, title: t.title, state: t.state, assignedTo: t.assignedTo, createdAt: t.createdAt })),
            analyses: operations.analyses(id, actor).map(a => ({ id: a.id, matchId: a.matchId, state: a.state, assignedTo: a.assignedTo, createdAt: a.createdAt })),
            duties: operations.duties(id, actor).map(d => ({ userId: d.userId, kind: d.kind, expiresAt: d.expiresAt })),
          }); return;
        }
        if (url.pathname === '/api/finance') {
          const reports = payments.report(id, actor).slice(0, 200);
          json(response, 200, { source: reports.some(r => r.source !== 'manual_records') ? 'mixed_records' : 'manual_records', records: reports.map(r => ({
            matchId: r.plan.matchId, expectedTotalCents: r.plan.expectedTotalCents, feeCents: r.plan.feeCents, prizeCents: r.plan.prizeCents,
            receivedCents: r.receivedCents, refundedCents: r.refundedCents, prizesPaidCents: r.prizesPaidCents,
            feesPaidCents: r.feesPaidCents, recordedCustodyCents: r.recordedCustodyCents, status: r.status, source: r.source,
          })) }); return;
        }
        if (url.pathname === '/api/audit') {
          const events = service.store.db.prepare("SELECT CAST(id AS TEXT)||':core' AS id,subject_id,actor_id,action,created_at FROM audit WHERE guild_id=? UNION ALL SELECT CAST(id AS TEXT)||':ops' AS id,subject_id,actor_id,action,created_at FROM operations_events WHERE guild_id=? ORDER BY created_at DESC LIMIT 100").all(id, id) as { id: string; subject_id: string; actor_id: string; action: string; created_at: number }[];
          json(response, 200, events.map(e => ({ id: e.id, subjectId: e.subject_id, actorId: e.actor_id, action: e.action, createdAt: e.created_at }))); return;
        }
        const cfg = service.config(id)!;
        json(response, 200, { guildId: cfg.guildId, categoryId: cfg.categoryId, staffRoleId: cfg.staffRoleId, mediatorRoleId: cfg.mediatorRoleId }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        const data = await jsonBody(request); const id = guild(data.guildId);
        const fields = ['categoryId', 'staffRoleId', 'mediatorRoleId'] as const;
        const values = Object.fromEntries(fields.map(name => { const value = stringField(data[name], name); if (!/^\d{17,22}$/.test(value) || value === id) throw new HttpError(400, 'Use IDs válidos e cargos específicos do Discord.'); return [name, value]; })) as Record<typeof fields[number], string>;
        service.configure({ ...service.config(id)!, ...values, guildId: id }, actor); json(response, 200, { ok: true }); return;
      }
      const action = /^\/api\/matches\/([a-zA-Z0-9-]+)\/(cancel|resolve)$/.exec(url.pathname);
      if (request.method === 'POST' && action) {
        const data = await jsonBody(request); const id = guild(data.guildId); const reason = stringField(data.reason, 'Justificativa');
        const match = action[2] === 'cancel' ? service.cancel(id, action[1]!, actor, reason) : service.resolve(id, action[1]!, actor, Number(data.winner), reason);
        json(response, 200, { id: match.id, state: match.state }); return;
      }
      json(response, 404, { error: 'Rota não encontrada.' });
    })().catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof HttpError) { if (error.status === 429) response.setHeader('Retry-After', '60'); json(response, error.status, { error: error.message }); }
      else if (error instanceof DomainError) json(response, error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 409, { error: error.message });
      else json(response, 500, { error: 'Não foi possível concluir a operação.' });
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  server.on('close', () => { sessions.clear(); rates.clear(); });
  return server;
}
