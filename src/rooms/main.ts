import { Client, Events, GatewayIntentBits } from 'discord.js';
import { Store } from '../database.js';
import { reportError } from '../config.js';
import { loadRoomsConfig, requireRoomsDiscord, managedRoomProvider, checkRoomCapabilities } from './config.js';
import { ManagedRoomsService } from './service.js';
import { ManagedRoomsRuntime } from './runtime.js';
import { RoomsHealthMonitor, roomsHealthFile, checkRoomsDatabase } from './health.js';
import { createRoomsShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const config = loadRoomsConfig(); requireRoomsDiscord(config);
  const store = new Store(config.databasePath);
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  let runtime: ManagedRoomsRuntime | undefined;
  let startup: Promise<void> | undefined;
  const health = new RoomsHealthMonitor({ file: roomsHealthFile(), discordReady: () => client.isReady(),
    checkDatabase: () => checkRoomsDatabase(store.db), onError: error => reportError(error, 'rooms_health') });
  let stopping = false;
  const close = createRoomsShutdown({ stopHealth: () => { stopping = true; health.stop(); },
    stopWork: async () => { await startup?.catch(() => {}); await runtime?.stop(); }, destroyClient: () => client.destroy(), closeStore: () => store.close(),
    onError: error => reportError(error, 'rooms_shutdown'), forceExit: () => process.exit(1) });
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const provider = managedRoomProvider(config, store);
    startup = checkRoomCapabilities(provider); await startup;
    if (stopping) return;
    const service = new ManagedRoomsService(store, provider);
    runtime = new ManagedRoomsRuntime(client, service, store);
    client.on(Events.Error, error => reportError(error, 'rooms_discord'));
    client.once(Events.ClientReady, () => {
      if (stopping) return;
      console.log(JSON.stringify({ event: 'rooms_ready', edition: 'rooms', provider: config.provider, simulated: provider.source === 'simulated' }));
      try { health.sample(); } catch (error) { reportError(error, 'rooms_health'); }
      runtime!.start();
    });
    health.start();
    await client.login(config.token);
  } catch (error) { await close(); throw error; }
}
void main().catch(error => { reportError(error, 'rooms_startup'); process.exitCode = 1; });
