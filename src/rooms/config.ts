import { requireCondition } from '../domain.js';
import { Store } from '../database.js';
import { HttpManagedRoomProvider } from './http-provider.js';
import { SimulatedManagedRoomProvider } from './simulated-provider.js';
import type { ManagedRoomProvider } from './types.js';

export type RoomsRuntimeConfig = {
  token?: string; clientId?: string; guildId?: string;
  databasePath: string; provider: 'simulated' | 'api';
  api?: { baseUrl: string; apiKey: string; contract: 'room-management-v2'; timeoutMs: number; authorizationScheme: 'Bearer' | 'raw' };
};

export function loadRoomsConfig(env: NodeJS.ProcessEnv = process.env): RoomsRuntimeConfig {
  const provider = env.ROOMS_PROVIDER || 'simulated';
  requireCondition(provider === 'simulated' || provider === 'api', 'ROOM_CONFIG', 'ROOMS_PROVIDER deve ser simulated ou api.');
  let api: RoomsRuntimeConfig['api'];
  if (provider === 'api') {
    requireCondition(env.ROOMS_API_CONTRACT === 'room-management-v2', 'ROOM_CONFIG', 'Confirme ROOMS_API_CONTRACT=room-management-v2 somente após validar o contrato do fornecedor.');
    requireCondition(env.ROOMS_API_URL && env.ROOMS_API_KEY, 'ROOM_CONFIG', 'Configure ROOMS_API_URL e ROOMS_API_KEY nas configurações seguras.');
    const timeoutMs = Number(env.ROOMS_API_TIMEOUT_MS || 10_000);
    requireCondition(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, 'ROOM_CONFIG', 'ROOMS_API_TIMEOUT_MS deve ser inteiro entre 100 e 60000.');
    const authorizationScheme = env.ROOMS_API_AUTH_SCHEME || 'Bearer';
    requireCondition(authorizationScheme === 'Bearer' || authorizationScheme === 'raw', 'ROOM_CONFIG', 'ROOMS_API_AUTH_SCHEME deve ser Bearer ou raw.');
    api = { baseUrl: env.ROOMS_API_URL, apiKey: env.ROOMS_API_KEY, contract: 'room-management-v2', timeoutMs, authorizationScheme };
  }
  return { token: env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN || undefined,
    clientId: env.DISCORD_CLIENT_ID || undefined, guildId: env.DISCORD_GUILD_ID || undefined,
    databasePath: env.DATABASE_PATH || '.data/rooms.sqlite', provider, api };
}

export function requireRoomsDiscord(config: RoomsRuntimeConfig, register = false): void {
  requireCondition(config.token, 'ROOM_CONFIG', 'Configure DISCORD_TOKEN de forma segura. Sem credenciais, use npm run demo.');
  if (register) for (const [name, value] of [['DISCORD_CLIENT_ID', config.clientId], ['DISCORD_GUILD_ID', config.guildId]]) {
    requireCondition(value && /^\d{17,22}$/.test(value), 'ROOM_CONFIG', `Configure ${name} com um ID válido do Discord.`);
  }
}

export function managedRoomProvider(config: RoomsRuntimeConfig, store: Store): ManagedRoomProvider {
  if (config.provider === 'simulated') return new SimulatedManagedRoomProvider(store);
  requireCondition(config.api, 'ROOM_CONFIG', 'A configuração da API de salas está incompleta.');
  return new HttpManagedRoomProvider(config.api);
}

export async function checkRoomCapabilities(provider: ManagedRoomProvider): Promise<void> {
  const catalog = await provider.getCatalog();
  const required = ['create', 'lookup', 'query', 'update', 'cancel', 'close'] as const;
  const missing = required.filter(name => catalog.capabilities[name] !== true);
  requireCondition(missing.length === 0, 'ROOM_CAPABILITIES', `O provedor não atende às operações obrigatórias: ${missing.join(', ')}.`);
}
