import { DatabaseSync } from 'node:sqlite';
import { loadConfig, reportError } from './config.js';

try {
  const config = loadConfig();
  const db = new DatabaseSync(':memory:'); db.prepare('SELECT 1').get(); db.close();
  console.log(JSON.stringify({
    node: process.versions.node, sqlite: 'ok', roomMode: config.roomMode,
    tokenConfigured: !!config.token, clientIdConfigured: !!config.clientId, guildIdConfigured: !!config.guildId,
    realRoomApi: config.roomMode === 'api' ? 'configured_not_live_verified' : 'not_configured',
    dashboardTokenConfigured: !!process.env.DASHBOARD_TOKEN,
    pixDefaultProvider: process.env.PAYMENT_PROVIDER || 'manual',
    mercadoPagoTokenConfigured: !!process.env.MP_ACCESS_TOKEN,
    mercadoPagoWebhookConfigured: !!process.env.MP_WEBHOOK_SECRET,
    efiClientConfigured: !!process.env.EFI_CLIENT_ID && !!process.env.EFI_CLIENT_SECRET,
    efiCertificatePathConfigured: !!process.env.EFI_CERT_FILE,
    automaticPayments: 'adapters_implemented_not_live_verified', manualFinance: 'available',
  }, null, 2));
} catch (error) { reportError(error, 'doctor'); process.exitCode = 1; }
