import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig, reportError, requireDiscord } from './config.js';
import { Store } from './database.js';
import { BotService } from './service.js';
import { BotRuntime } from './bot/runtime.js';

async function main(): Promise<void> {
  const config = loadConfig(); requireDiscord(config);
  const store = new Store(config.databasePath);
  const service = new BotService(store, config.confirmationTimeoutMs);
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const runtime = new BotRuntime(client, service, config);
  client.on(Events.Error, error => reportError(error, 'discord_client'));
  client.once(Events.ClientReady, () => {
    console.log(JSON.stringify({ event: 'ready', roomMode: config.roomMode, guilds: client.guilds.cache.size }));
    runtime.start();
  });
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await runtime.stop(); await client.destroy(); store.close();
  };
  process.once('SIGINT', () => { void close().catch(error => { reportError(error, 'shutdown'); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void close().catch(error => { reportError(error, 'shutdown'); process.exitCode = 1; }); });
  try { await client.login(config.token); }
  catch (error) { await close(); throw error; }
}
void main().catch(error => { reportError(error, 'startup'); process.exitCode = 1; });
