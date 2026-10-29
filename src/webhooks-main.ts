import { loadConfig, reportError } from './config.js';
import { requireCondition } from './domain.js';
import { Store } from './database.js';
import { BotService } from './service.js';
import { PaymentsService } from './payments.js';
import { PaymentHub } from './payment-hub.js';
import { createPaymentWebhookServer } from './payment-webhooks.js';

function main(): void {
  const config = loadConfig(); const store = new Store(config.databasePath);
  try {
    const service = new BotService(store); const hub = new PaymentHub(service, new PaymentsService(store, service));
    requireCondition(hub.mercadoPago && process.env.MP_WEBHOOK_SECRET, 'WEBHOOK_CONFIG', 'Configure MP_ACCESS_TOKEN e MP_WEBHOOK_SECRET antes de iniciar o receptor.');
    const port = Number(process.env.WEBHOOK_PORT || 3001);
    requireCondition(Number.isInteger(port) && port >= 1 && port <= 65535, 'WEBHOOK_CONFIG', 'WEBHOOK_PORT deve ser um inteiro de 1 a 65535.');
    const server = createPaymentWebhookServer({ mercadoPago: hub.mercadoPago, onMercadoPagoPayment: payment => hub.acceptMercadoPagoWebhook(payment) });
    const host = process.env.WEBHOOK_HOST || '127.0.0.1';
    requireCondition(['127.0.0.1', '::1'].includes(host), 'WEBHOOK_CONFIG', 'Publique o webhook por reverse proxy HTTPS; mantenha o processo em loopback.');
    server.once('error', error => { reportError(error, 'webhooks'); store.close(); process.exitCode = 1; });
    const close = () => { server.close(() => store.close()); server.closeIdleConnections(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    server.listen(port, host, () => console.log(JSON.stringify({ event: 'webhook_ready', provider: 'mercadopago', port })));
  } catch (error) { store.close(); throw error; }
}
try { main(); } catch (error) { reportError(error, 'webhooks_startup'); process.exitCode = 1; }
