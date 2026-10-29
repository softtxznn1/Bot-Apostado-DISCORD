import { REST, Routes } from 'discord.js';
import { commands } from './bot/commands.js';
import { loadConfig, reportError, requireDiscord } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig(); requireDiscord(config, true);
  const rest = new REST({ version: '10' }).setToken(config.token!);
  // POST atualiza cada comando pelo nome, preservando outros comandos da aplicação.
  for (const command of commands) await rest.post(Routes.applicationGuildCommands(config.clientId!, config.guildId!), { body: command });
  console.log(`${commands.length} comandos registrados no servidor de teste.`);
}
void main().catch(error => { reportError(error, 'register_commands'); process.exitCode = 1; });
