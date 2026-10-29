import { REST, Routes } from 'discord.js';
import { HttpManagedRoomProvider } from './http-provider.js';
import { roomCommands } from './commands.js';
import { checkRoomCapabilities, type RoomsRuntimeConfig } from './config.js';
import type { ManagedRoomProvider } from './types.js';

type Check = { id: string; state: 'passed' | 'blocked' | 'failed'; code: string; message: string };
export type RoomsConnectionReport = {
  edition: 'rooms'; readOnly: true; connectionsVerified: boolean; homologated: false; checks: Check[];
};
type Dependencies = {
  discordGet: (route: `/${string}`) => Promise<unknown>;
  roomProvider: () => ManagedRoomProvider;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const snowflake = (value: string | undefined): value is string => !!value && /^\d{17,22}$/.test(value);

/** Compare configuration fields, ignoring API metadata and explicit default values. */
function commandSchema(value: unknown, root = true): unknown {
  if (!record(value)) return null;
  const schema: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'min_value', 'max_value', 'min_length', 'max_length']) {
    if (value[key] !== undefined) schema[key] = value[key];
  }
  if (Array.isArray(value.channel_types)) schema.channel_types = [...value.channel_types].sort();
  if (Array.isArray(value.choices)) schema.choices = value.choices.map(choice => record(choice) ? { name: choice.name, value: choice.value } : null);
  schema.type = value.type ?? (root ? 1 : undefined);
  if (value.required === true) schema.required = true;
  if (value.autocomplete === true) schema.autocomplete = true;
  if (Array.isArray(value.options) && value.options.length) schema.options = value.options.map(option => commandSchema(option, false));
  return schema;
}
function registeredCommandsMatch(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== roomCommands.length) return false;
  const expected = [...roomCommands].sort((a, b) => a.name.localeCompare(b.name));
  if (!value.every(record)) return false;
  const actual = [...value].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return JSON.stringify(expected.map(command => commandSchema(command))) === JSON.stringify(actual.map(command => commandSchema(command)));
}

/** Read-only checks. This never opens the production DB, registers commands or creates rooms. */
export async function verifyRoomsConnections(config: RoomsRuntimeConfig, overrides: Partial<Dependencies> = {}): Promise<RoomsConnectionReport> {
  const checks: Check[] = [];
  const add = (id: string, state: Check['state'], code: string, message: string) => checks.push({ id, state, code, message });
  const rest = new REST({ version: '10', timeout: 10_000, retries: 0, rejectOnRateLimit: () => true });
  if (config.token) rest.setToken(config.token);
  const get = overrides.discordGet ?? (route => rest.get(route));
  const failure = (id: string, error: unknown) => {
    const status = record(error) ? error.status : undefined;
    const code = status === 401 ? 'DISCORD_AUTH_FAILED' : status === 403 ? 'DISCORD_ACCESS_DENIED'
      : status === 404 ? 'DISCORD_RESOURCE_MISSING' : status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_CHECK_FAILED';
    add(id, 'failed', code, 'A consulta ao Discord falhou. Confira a credencial, os IDs, a instalação do bot e o acesso de rede.');
  };

  let applicationVerified = false; let guildVerified = false;
  if (!config.token || !snowflake(config.clientId)) {
    add('discord.application', 'blocked', 'DISCORD_CONFIG_MISSING', 'Configure DISCORD_TOKEN e DISCORD_CLIENT_ID válido nas variáveis seguras.');
  } else {
    try {
      const application = await get(Routes.oauth2CurrentApplication());
      if (record(application) && application.id === config.clientId) {
        applicationVerified = true;
        add('discord.application', 'passed', 'DISCORD_APPLICATION_OK', 'A credencial pertence à aplicação configurada.');
      } else add('discord.application', 'failed', 'DISCORD_APPLICATION_MISMATCH', 'A credencial não confirmou a aplicação configurada. Confira DISCORD_CLIENT_ID.');
    } catch (error) { failure('discord.application', error); }
  }
  if (!config.token || !snowflake(config.guildId)) {
    add('discord.guild', 'blocked', 'DISCORD_CONFIG_MISSING', 'Configure DISCORD_TOKEN e DISCORD_GUILD_ID válido nas variáveis seguras.');
  } else {
    try {
      const guild = await get(Routes.guild(config.guildId));
      if (record(guild) && guild.id === config.guildId) {
        guildVerified = true;
        add('discord.guild', 'passed', 'DISCORD_GUILD_OK', 'O bot consegue consultar o servidor configurado.');
      } else add('discord.guild', 'failed', 'DISCORD_GUILD_MISMATCH', 'O Discord não confirmou o servidor configurado.');
    } catch (error) { failure('discord.guild', error); }
  }
  if (!applicationVerified || !guildVerified) {
    add('discord.commands', 'blocked', 'DISCORD_CHECK_PREREQUISITE', 'Confirme aplicação e servidor antes de verificar os comandos registrados.');
  } else {
    try {
      const commands = await get(Routes.applicationGuildCommands(config.clientId!, config.guildId!));
      if (registeredCommandsMatch(commands)) add('discord.commands', 'passed', 'DISCORD_COMMANDS_OK', 'Os comandos registrados correspondem à edição de salas e suas opções.');
      else add('discord.commands', 'failed', 'DISCORD_COMMANDS_DIFFER', 'Os comandos estão ausentes ou desatualizados. Confira aplicação/servidor e execute npm run register para registrar a edição de salas.');
    } catch (error) { failure('discord.commands', error); }
  }

  if (config.provider !== 'api' || !config.api) {
    add('rooms.catalog', 'blocked', 'ROOM_PROVIDER_SIMULATED', 'O provedor é simulado. Configure o fornecedor real e confirme o contrato antes da homologação.');
  } else {
    try {
      const provider = overrides.roomProvider?.() ?? new HttpManagedRoomProvider(config.api);
      // Explicit source check prevents a simulator from being counted as a real connection.
      if (provider.source !== 'external') {
        add('rooms.catalog', 'failed', 'ROOM_PROVIDER_SIMULATED', 'A conexão fornecida é de demonstração.');
      } else {
        await checkRoomCapabilities(provider);
        add('rooms.catalog', 'passed', 'ROOM_CATALOG_OK', 'A API respondeu ao catálogo com as seis capacidades obrigatórias declaradas. As operações reais ainda precisam ser homologadas.');
      }
    } catch {
      // Neither the raw HTTP/SDK error nor the catalog may expose remote secrets.
      add('rooms.catalog', 'failed', 'ROOM_PROVIDER_CHECK_FAILED', 'Não foi possível confirmar o catálogo e as capacidades. Confira contrato, credencial, HTTPS e acesso ao fornecedor.');
    }
  }
  return { edition: 'rooms', readOnly: true, connectionsVerified: checks.every(check => check.state === 'passed'), homologated: false, checks };
}
