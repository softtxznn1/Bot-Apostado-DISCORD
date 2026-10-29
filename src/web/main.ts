import { loadConfig, reportError } from '../config.js';
import { DomainError } from '../domain.js';
import { Store } from '../database.js';
import { BotService } from '../service.js';
import { createDashboardServer } from './server.js';

function main(): void {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) throw new DomainError('DASHBOARD_CONFIG', 'Configure DASHBOARD_TOKEN nas variáveis seguras para iniciar o painel.');
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const containerBind = host === '0.0.0.0' && process.env.DASHBOARD_CONTAINER_BIND === 'true';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !containerBind) throw new DomainError('DASHBOARD_CONFIG', 'DASHBOARD_HOST deve ser loopback. Bind de container exige DASHBOARD_CONTAINER_BIND=true e publicação restrita ao host.');
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DomainError('DASHBOARD_CONFIG', 'DASHBOARD_PORT deve ser um inteiro de 1 a 65535.');
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const allowedGuildIds = process.env.DASHBOARD_GUILD_IDS?.split(',').map(s => s.trim()).filter(Boolean);
  const allowedHosts = process.env.DASHBOARD_ALLOWED_HOSTS?.split(',').map(s => s.trim()).filter(Boolean);
  const server = createDashboardServer(new BotService(store, config.confirmationTimeoutMs), { token, allowedGuildIds, allowedHosts, secureCookies: process.env.DASHBOARD_SECURE_COOKIES === 'true' });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    server.close(() => { store.close(); }); server.closeIdleConnections();
  };
  server.once('error', error => { reportError(error, 'dashboard'); store.close(); process.exitCode = 1; });
  process.once('SIGINT', close); process.once('SIGTERM', close);
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'dashboard_ready', host, port, access: 'authenticated', scope: allowedGuildIds?.length ? 'restricted_guilds' : 'all_local_guilds' })));
}
try { main(); } catch (error) { reportError(error, 'dashboard_startup'); process.exitCode = 1; }
