import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/database.js';
import { BotService } from '../src/service.js';
import { OperationsService } from '../src/operations.js';
import { PaymentsService } from '../src/payments.js';
import { createDashboardServer, type DashboardOptions } from '../src/web/server.js';
import { dashboardJs } from '../src/web/dashboard.js';

const token = 'test-dashboard-key-32-characters-long';
const guild = '111111111111111111';
const otherGuild = '222222222222222222';
const admin = { userId: 'admin', moderator: true, mediator: false };
const player = { userId: 'p1', moderator: false, mediator: false };

async function setup(t: TestContext, options: Partial<DashboardOptions> = {}) {
  const store = new Store(':memory:'); const service = new BotService(store);
  for (const guildId of [guild, otherGuild]) service.configure({ guildId, categoryId: '333333333333333333', staffRoleId: '444444444444444444', mediatorRoleId: '555555555555555555' }, admin);
  const queue = service.createQueue(guild, admin, 1, 'mobile', 'Regras de teste do painel.', 100);
  service.joinQueue(guild, queue.id, 'p1'); const match = service.joinQueue(guild, queue.id, 'p2').match!;
  service.confirm(guild, match.id, 'p1'); service.confirm(guild, match.id, 'p2'); service.claim(guild, match.id, admin);
  service.informRoom(guild, match.id, admin, '987654321', 'NEVER_LEAK_ROOM_PASSWORD');
  const server = createDashboardServer(service, { token, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const post = (path: string, value: unknown) => get(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { store, service, server, base, match, queue, get, post };
}
async function login(base: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const session = await fetch(base + '/api/session', { headers: { Cookie: cookie } });
  const data = await session.json() as { csrf: string };
  return { cookie, csrf: data.csrf };
}

test('dashboard exige autenticação e não aceita credenciais na URL', async t => {
  const f = await setup(t);
  const root = await fetch(f.base, { redirect: 'manual' }); assert.equal(root.status, 303); assert.equal(root.headers.get('location'), '/login');
  for (const path of ['/api/guilds', '/api/session', `/api/matches?guildId=${guild}`, '/assets/app.js']) {
    const response = await fetch(f.base + path); assert.equal(response.status, 401, path);
  }
  const invalid = await fetch(f.base + '/api/guilds', { headers: { Authorization: 'Bearer invalid' } }); assert.equal(invalid.status, 401);
  const leaked = await fetch(f.base + '/api/guilds?token=' + token); assert.equal(leaked.status, 400); assert.ok(!(await leaked.text()).includes(token));
});

test('login cria sessão HttpOnly, não reflete token e carrega interface protegida', async t => {
  const f = await setup(t);
  const response = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie')!;
  assert.ok(setCookie.includes('HttpOnly')); assert.ok(setCookie.includes('SameSite=Strict')); assert.ok(!setCookie.includes(token));
  const page = await fetch(f.base, { headers: { Cookie: setCookie.split(';')[0]! } });
  assert.equal(page.status, 200); const html = await page.text(); assert.ok(html.includes('Central') || html.includes('CENTRAL')); assert.ok(!html.includes(token));
  assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
});

test('sessão exige CSRF em mutações e registra cancelamento autorizado', async t => {
  const f = await setup(t); const session = await login(f.base);
  const path = f.base + `/api/matches/${f.match.id}/cancel`;
  const init = { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId: guild, reason: 'Cancelamento operacional autorizado.' }) };
  const missing = await fetch(path, init); assert.equal(missing.status, 403); assert.equal(f.service.match(guild, f.match.id).state, 'room_created');
  const wrong = await fetch(path, { ...init, headers: { ...init.headers, 'X-CSRF-Token': 'invalid' } }); assert.equal(wrong.status, 403);
  const response = await fetch(path, { ...init, headers: { ...init.headers, 'X-CSRF-Token': session.csrf } });
  assert.equal(response.status, 200); assert.equal(f.service.match(guild, f.match.id).state, 'cancelled');
  const audit = f.store.db.prepare("SELECT actor_id FROM audit WHERE action='match_cancelled'").get(); assert.equal(audit?.actor_id, 'dashboard-operator');
});

test('origem externa não autentica nem executa mutações, mesmo com credencial', async t => {
  const f = await setup(t);
  const response = await fetch(f.base + '/login', { method: 'POST', headers: { Origin: 'https://external.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), redirect: 'manual' });
  assert.equal(response.status, 403);
  const action = await f.get(`/api/matches/${f.match.id}/cancel`, { method: 'POST', headers: { Origin: 'https://external.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId: guild, reason: 'Origem incorreta.' }) });
  assert.equal(action.status, 403); assert.equal(f.service.match(guild, f.match.id).state, 'room_created');
});

test('APIs consultam métricas reais e omitem sala, senha e detalhes de auditoria', async t => {
  const f = await setup(t);
  f.store.db.prepare('INSERT INTO audit(guild_id,subject_id,actor_id,action,created_at,details) VALUES(?,?,?,?,?,?)').run(guild, f.match.id, 'admin', 'test_sensitive_details', Date.now(), JSON.stringify({ token: 'NEVER_LEAK_AUDIT_DETAILS' }));
  const overview = await f.get(`/api/overview?guildId=${guild}`); assert.equal(overview.status, 200);
  assert.deepEqual(await overview.json(), { activeMatches: 1, disputedMatches: 0, finishedMatches: 0, queuedPlayers: 0 });
  const matches = await f.get(`/api/matches?guildId=${guild}`); const text = await matches.text();
  assert.ok(text.includes(f.match.id)); assert.ok(!text.includes('NEVER_LEAK_ROOM_PASSWORD')); assert.ok(!text.includes('987654321')); assert.ok(!text.includes('password'));
  const audit = await f.get(`/api/audit?guildId=${guild}`); const events = await audit.text();
  assert.ok(events.includes('test_sensitive_details')); assert.ok(!events.includes('NEVER_LEAK_AUDIT_DETAILS'));
  assert.ok((JSON.parse(events) as Record<string, unknown>[]).every(event => !('details' in event)));
});

test('escopo de servidor restringe consultas, configuração e ações cruzadas', async t => {
  const f = await setup(t, { allowedGuildIds: [guild] });
  const guilds = await f.get('/api/guilds'); assert.deepEqual(await guilds.json(), [{ guildId: guild }]);
  assert.equal((await f.get(`/api/matches?guildId=${otherGuild}`)).status, 404);
  assert.equal((await f.post(`/api/matches/${f.match.id}/cancel`, { guildId: otherGuild, reason: 'Tentativa em outro servidor.' })).status, 404);
  assert.equal((await f.get('/api/matches?guildId=unknown')).status, 404);
  assert.equal(f.service.match(guild, f.match.id).state, 'room_created');
});

test('identificador de uma partida não permite ação no servidor errado', async t => {
  const f = await setup(t);
  assert.equal((await f.post(`/api/matches/${f.match.id}/cancel`, { guildId: otherGuild, reason: 'Servidor sem esta partida.' })).status, 404);
  assert.equal(f.service.match(guild, f.match.id).state, 'room_created');
});

test('decisão de disputa usa o domínio e atualiza ranking sem duplicar resultado', async t => {
  const f = await setup(t);
  f.service.startMatch(guild, f.match.id, admin); f.service.proposeResult(guild, f.match.id, admin, 1, '7x3'); f.service.dispute(guild, f.match.id, 'p2', 'O vídeo precisa ser conferido.');
  const response = await f.post(`/api/matches/${f.match.id}/resolve`, { guildId: guild, winner: 2, reason: 'Vídeo conferido pela administração.' });
  assert.equal(response.status, 200); assert.equal(f.service.ranking(guild)[0]?.userId, 'p2');
  const duplicate = await f.post(`/api/matches/${f.match.id}/resolve`, { guildId: guild, winner: 2, reason: 'Decisão repetida.' }); assert.equal(duplicate.status, 409);
  assert.equal(f.service.ranking(guild)[0]?.wins, 1);
});

test('configuração validada preserva o servidor e é persistida', async t => {
  const f = await setup(t);
  const cfg = { guildId: guild, categoryId: '666666666666666666', staffRoleId: '777777777777777777', mediatorRoleId: '888888888888888888' };
  assert.equal((await f.post('/api/config', { ...cfg, staffRoleId: guild })).status, 400);
  assert.equal((await f.post('/api/config', cfg)).status, 200);
  assert.equal(f.service.config(guild)?.categoryId, cfg.categoryId);
  const response = await f.get(`/api/config?guildId=${guild}`); assert.deepEqual(await response.json(), cfg);
});

test('logout invalida sessão e expiração não permite reutilização do cookie', async t => {
  let clock = Date.now(); const f = await setup(t, { now: () => clock, sessionTtlMs: 1000 });
  const first = await login(f.base);
  const logout = await fetch(f.base + '/logout', { method: 'POST', headers: { Cookie: first.cookie, 'X-CSRF-Token': first.csrf } });
  assert.equal(logout.status, 200); assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await fetch(f.base + '/api/session', { headers: { Cookie: first.cookie } })).status, 401);
  const second = await login(f.base); clock += 1001;
  assert.equal((await fetch(f.base + '/api/session', { headers: { Cookie: second.cookie } })).status, 401);
});

test('limites de corpo e JSON inválido falham antes da ação', async t => {
  const f = await setup(t);
  const oversized = await f.get(`/api/matches/${f.match.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId: guild, reason: 'x'.repeat(20_000) }) });
  assert.equal(oversized.status, 413);
  const malformed = await f.get(`/api/matches/${f.match.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(f.service.match(guild, f.match.id).state, 'room_created');
});

test('tentativas de login são limitadas sem refletir segredo', async t => {
  const f = await setup(t, { loginRateLimit: 2 });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'untrusted-user-input-secret' }) });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('untrusted-user-input-secret'));
  }
  const limited = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
});

test('Host não autorizado é rejeitado antes de servir o painel', async t => {
  const f = await setup(t);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(f.base, { headers: { Host: 'attacker.invalid', Authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode!); });
    request.once('error', reject); request.end();
  });
  assert.equal(status, 403);
});

test('atendimento e finanças têm readmodels administrativos sem evidências e referências', async t => {
  const f = await setup(t);
  const operations = new OperationsService(f.store, f.service);
  const ticket = operations.openTicket(guild, player, 'Atendimento privado', 'NEVER_LEAK_TICKET_DESCRIPTION');
  operations.requestAnalysis(guild, f.match.id, player, 'p2', 'NEVER_LEAK_ANALYSIS_REASON', 'https://cdn.discordapp.com/attachments/example/private.png?token=NEVER_LEAK_EVIDENCE');
  operations.enterDuty(guild, admin, 'mediator');
  const response = await f.get(`/api/operations?guildId=${guild}`); const content = await response.text();
  assert.ok(content.includes(ticket.id)); assert.ok(content.includes('mediator'));
  for (const secret of ['NEVER_LEAK_TICKET_DESCRIPTION', 'NEVER_LEAK_ANALYSIS_REASON', 'NEVER_LEAK_EVIDENCE']) assert.ok(!content.includes(secret));
  f.service.joinQueue(guild, f.queue.id, 'p3'); const second = f.service.joinQueue(guild, f.queue.id, 'p4').match!;
  f.service.confirm(guild, second.id, 'p3'); f.service.confirm(guild, second.id, 'p4'); f.service.claim(guild, second.id, admin);
  const payments = new PaymentsService(f.store, f.service); payments.configurePlan(guild, second.id, admin, 1000);
  payments.confirmReceipt(guild, second.id, admin, 'p3', 100, 'NEVER_LEAK_TRANSFER_REF', 'http-test-receipt');
  const finance = await f.get(`/api/finance?guildId=${guild}`); const data = await finance.text();
  assert.ok(data.includes('manual_records')); assert.ok(data.includes('"receivedCents":100')); assert.ok(!data.includes('NEVER_LEAK_TRANSFER_REF'));
});

type MockBrowserEvent = { currentTarget: MockBrowserElement; preventDefault(): void };
class MockBrowserElement {
  value = ''; textContent = ''; disabled = false; hidden = false; open = false;
  readonly elements: Record<string, MockBrowserElement> = {};
  children: MockBrowserElement[] = [];
  readonly classList = { toggle(_name: string, _enabled: boolean): void {} };
  private readonly listeners = new Map<string, (event: MockBrowserEvent) => unknown>();
  private button: MockBrowserElement | undefined;
  constructor(readonly tag = 'div') {}
  addEventListener(type: string, listener: (event: MockBrowserEvent) => unknown): void { this.listeners.set(type, listener); }
  async dispatch(type: string): Promise<void> { await this.listeners.get(type)?.({ currentTarget: this, preventDefault() {} }); }
  append(...children: MockBrowserElement[]): void {
    this.children.push(...children);
    if (this.tag === 'select' && !this.value) this.value = children[0]?.value ?? '';
  }
  replaceChildren(...children: MockBrowserElement[]): void { this.children = children; }
  querySelector(_selector: string): MockBrowserElement { return this.button ??= new MockBrowserElement('button'); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}

function browserFixture() {
  const nodes = new Map<string, MockBrowserElement>();
  const node = (id: string): MockBrowserElement => {
    let element = nodes.get(id);
    if (!element) { element = new MockBrowserElement(id === 'guild' || id === 'state' ? 'select' : 'div'); nodes.set(id, element); }
    return element;
  };
  for (const name of ['categoryId', 'staffRoleId', 'mediatorRoleId']) node('settings-form').elements[name] = new MockBrowserElement('input');
  for (const name of ['reason', 'winner']) node('action-form').elements[name] = new MockBrowserElement('input');
  const configuration = (id: string) => ({ guildId: id, categoryId: `category-${id}`, staffRoleId: `staff-${id}`, mediatorRoleId: `mediator-${id}` });
  const pending: { url: URL; done: boolean; resolve: (value: unknown) => void }[] = [];
  const posts: Record<string, unknown>[] = [];
  const response = (value: unknown) => ({ ok: true, status: 200, async json() { return value; } });
  const fetch = (path: string, init: { method?: string; body?: string } = {}) => {
    const url = new URL(path, 'http://dashboard.test');
    if (url.pathname === '/api/session') return Promise.resolve(response({ csrf: 'csrf-for-test' }));
    if (url.pathname === '/api/guilds') return Promise.resolve(response([{ guildId: guild }, { guildId: otherGuild }]));
    if (url.pathname === '/api/config' && init.method === 'POST') {
      posts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>); return Promise.resolve(response({ ok: true }));
    }
    return new Promise(resolve => pending.push({ url, done: false, resolve: value => resolve(response(value)) }));
  };
  runInNewContext(dashboardJs, {
    document: { getElementById: node, createElement: (tag: string) => new MockBrowserElement(tag) },
    fetch, URL, Date, encodeURIComponent, location: { assign() {} },
  });
  const resolveGuild = (id: string) => {
    const values: Record<string, unknown> = {
      '/api/overview': { activeMatches: 0, disputedMatches: 0, finishedMatches: 0, queuedPlayers: 0 },
      '/api/config': configuration(id), '/api/matches': [], '/api/queues': [], '/api/ranking': [], '/api/audit': [],
      '/api/operations': { tickets: [], analyses: [], duties: [] }, '/api/finance': { records: [] },
    };
    for (const request of pending) if (!request.done && request.url.searchParams.get('guildId') === id) {
      request.done = true; request.resolve(values[request.url.pathname]);
    }
  };
  return { node, pending, posts, resolveGuild, configuration };
}
const browserTick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const oldResponseFirst of [false, true]) test(`troca de servidor descarta configuração antiga e bloqueia submissão durante carga (resposta antiga ${oldResponseFirst ? 'primeiro' : 'por último'})`, async () => {
  const browser = browserFixture(); await browserTick();
  assert.equal(browser.pending.filter(r => r.url.searchParams.get('guildId') === guild).length, 8);
  browser.node('guild').value = otherGuild; await browser.node('guild').dispatch('change'); await browserTick();
  const form = browser.node('settings-form');
  assert.equal(form.elements.categoryId!.value, ''); assert.equal(form.querySelector('button').disabled, true);
  await form.dispatch('submit'); assert.equal(browser.posts.length, 0, 'Submissão programática sem configuração carregada deve ser bloqueada.');
  if (oldResponseFirst) {
    browser.resolveGuild(guild); await browserTick();
    assert.equal(form.elements.categoryId!.value, ''); assert.equal(form.querySelector('button').disabled, true);
  }
  browser.resolveGuild(otherGuild); await browserTick();
  const expected = browser.configuration(otherGuild);
  assert.equal(form.elements.categoryId!.value, expected.categoryId); assert.equal(form.elements.staffRoleId!.value, expected.staffRoleId);
  assert.equal(form.querySelector('button').disabled, false);
  form.elements.categoryId!.value = 'edited-category-of-selected-guild';
  if (!oldResponseFirst) { browser.resolveGuild(guild); await browserTick(); }
  assert.equal(form.elements.categoryId!.value, 'edited-category-of-selected-guild', 'Resposta antiga não pode sobrescrever o formulário do servidor atual.');
  assert.equal(form.elements.staffRoleId!.value, expected.staffRoleId);
  const submission = form.dispatch('submit'); await browserTick();
  assert.equal(browser.posts.length, 1);
  assert.deepEqual(browser.posts[0], { ...expected, categoryId: 'edited-category-of-selected-guild' });
  browser.resolveGuild(otherGuild); await submission;
});
