import { DomainError, requireCondition } from './domain.js';

export type RuntimeConfig = {
  token: string | undefined; clientId: string | undefined; guildId: string | undefined;
  databasePath: string; roomMode: 'manual' | 'simulated' | 'api'; confirmationTimeoutMs: number;
  roomApi?: {
    contract: 'room-contract-v1'; baseUrl: string; apiKey: string; createPath: string;
    lookupPath?: string; lookupMethod: 'GET' | 'POST'; authorizationScheme: 'Bearer' | 'raw';
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const roomMode = env.ROOM_MODE || 'manual';
  requireCondition(roomMode === 'manual' || roomMode === 'simulated' || roomMode === 'api', 'CONFIG', 'ROOM_MODE deve ser manual, simulated ou api.');
  const seconds = Number(env.CONFIRMATION_TIMEOUT_SECONDS || 180);
  requireCondition(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'CONFIG', 'CONFIRMATION_TIMEOUT_SECONDS deve ser um inteiro de 30 a 3600.');
  let roomApi: RuntimeConfig['roomApi'];
  if (roomMode === 'api') {
    requireCondition(env.ROOM_API_CONTRACT === 'room-contract-v1', 'CONFIG', 'Confirme ROOM_API_CONTRACT=room-contract-v1 somente após verificar a compatibilidade com seu provedor.');
    requireCondition(env.ROOM_API_URL && env.ROOM_API_KEY && env.ROOM_API_CREATE_PATH, 'CONFIG', 'Configure ROOM_API_URL, ROOM_API_KEY e ROOM_API_CREATE_PATH nas configurações seguras.');
    requireCondition(!env.ROOM_API_LOOKUP_METHOD || ['GET', 'POST'].includes(env.ROOM_API_LOOKUP_METHOD), 'CONFIG', 'ROOM_API_LOOKUP_METHOD deve ser GET ou POST.');
    requireCondition(!env.ROOM_API_AUTH_SCHEME || ['Bearer', 'raw'].includes(env.ROOM_API_AUTH_SCHEME), 'CONFIG', 'ROOM_API_AUTH_SCHEME deve ser Bearer ou raw.');
    roomApi = { contract: 'room-contract-v1', baseUrl: env.ROOM_API_URL, apiKey: env.ROOM_API_KEY,
      createPath: env.ROOM_API_CREATE_PATH, lookupPath: env.ROOM_API_LOOKUP_PATH || undefined,
      lookupMethod: (env.ROOM_API_LOOKUP_METHOD || 'GET') as 'GET' | 'POST',
      authorizationScheme: (env.ROOM_API_AUTH_SCHEME || 'Bearer') as 'Bearer' | 'raw' };
  }
  return {
    token: env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN || undefined,
    clientId: env.DISCORD_CLIENT_ID || undefined, guildId: env.DISCORD_GUILD_ID || undefined,
    databasePath: env.DATABASE_PATH || '.data/bot.sqlite', roomMode, roomApi, confirmationTimeoutMs: seconds * 1000,
  };
}

export function requireDiscord(config: RuntimeConfig, registration = false): void {
  if (!config.token) throw new DomainError('CONFIG', 'Configure DISCORD_TOKEN nas variáveis seguras ou em um arquivo .env local. Use npm run demo sem credenciais.');
  if (registration) for (const [name, value] of [['DISCORD_CLIENT_ID', config.clientId], ['DISCORD_GUILD_ID', config.guildId]]) {
    requireCondition(value && /^\d{17,22}$/.test(value), 'CONFIG', `Configure ${name} com um ID válido do Discord.`);
  }
}

export function reportError(error: unknown, context: string): void {
  // Não serializar erros de SDK/HTTP: podem conter cabeçalhos ou payloads sensíveis.
  console.error(JSON.stringify({ context, error: error instanceof DomainError ? error.message : error instanceof Error ? error.name : 'UnknownError' }));
}
