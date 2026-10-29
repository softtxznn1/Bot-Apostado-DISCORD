import { REST, Routes } from 'discord.js';
import { reportError } from '../config.js';
import { loadRoomsConfig, requireRoomsDiscord } from './config.js';
import { roomCommands } from './commands.js';

async function main(): Promise<void> {
  const config = loadRoomsConfig(); requireRoomsDiscord(config, true);
  const rest = new REST({ version: '10' }).setToken(config.token!);
  // Replaces this application's guild commands with the dedicated rooms edition.
  // Other applications/servers are unaffected; legacy commands can be restored explicitly.
  await rest.put(Routes.applicationGuildCommands(config.clientId!, config.guildId!), { body: roomCommands });
  console.log(`${roomCommands.length} comandos de salas registrados. Comandos de apostados desta aplicação foram retirados deste servidor.`);
}
void main().catch(error => { reportError(error, 'rooms_register'); process.exitCode = 1; });
