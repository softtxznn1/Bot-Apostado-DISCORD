import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Routes } from 'discord.js';
import { roomCommands } from '../src/rooms/commands.js';
import { loadRoomsConfig } from '../src/rooms/config.js';
import { verifyRoomsConnections } from '../src/rooms/verification.js';
import type { ManagedRoomProvider, RoomCatalog } from '../src/rooms/types.js';

const appId = '111111111111111111'; const guildId = '222222222222222222';
const config = () => loadRoomsConfig({ DISCORD_TOKEN: 'private-discord-token', DISCORD_CLIENT_ID: appId, DISCORD_GUILD_ID: guildId,
  ROOMS_PROVIDER: 'api', ROOMS_API_CONTRACT: 'room-management-v2', ROOMS_API_URL: 'https://unqueried.example', ROOMS_API_KEY: 'private-api-key' });
const catalog = (): RoomCatalog => ({ revision: 'fixture', maps: [{ id: 'map', label: 'Map' }], modes: [{ id: 'mode', label: 'Mode', mapIds: ['map'],
  minPlayers: 2, maxPlayers: 50, optionFields: [], editableFields: [] }],
  capabilities: { create: true, lookup: true, query: true, update: true, cancel: true, close: true } });
const provider = (value = catalog(), source: 'external' | 'simulated' = 'external'): ManagedRoomProvider => {
  const write = async (): Promise<never> => { throw new Error('Verification must never create, update, cancel or close rooms.'); };
  return { source, identity: 'fixture', getCatalog: async () => value, createRoom: write, updateRoom: write, cancelRoom: write, closeRoom: write,
    getRoom: write, findRoom: write };
};
function discordGet(commands: unknown = roomCommands, routes: string[] = []) {
  return async (route: `/${string}`): Promise<unknown> => {
    routes.push(route);
    if (route === Routes.oauth2CurrentApplication()) return { id: appId };
    if (route === Routes.guild(guildId)) return { id: guildId };
    assert.equal(route, Routes.applicationGuildCommands(appId, guildId));
    return commands;
  };
}

test('verificação sem credenciais informa todos os bloqueios e não acessa rede nem banco', async () => {
  const never = () => { assert.fail('No external dependencies should be called.'); };
  const report = await verifyRoomsConnections(loadRoomsConfig({}), { discordGet: never, roomProvider: never });
  assert.equal(report.connectionsVerified, false);
  assert.equal(report.homologated, false);
  assert.equal(report.checks.length, 4);
  assert.ok(report.checks.every(check => check.state === 'blocked'));
});

test('verificação confirma aplicação, servidor, schema e catálogo exclusivamente por leituras', async () => {
  const routes: string[] = []; let catalogReads = 0;
  const api = provider(); const getCatalog = api.getCatalog;
  api.getCatalog = async () => { catalogReads++; return getCatalog(); };
  const report = await verifyRoomsConnections(config(), { discordGet: discordGet(roomCommands, routes), roomProvider: () => api });
  assert.equal(report.connectionsVerified, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.homologated, false);
  assert.equal(catalogReads, 1);
  assert.deepEqual(routes, [Routes.oauth2CurrentApplication(), Routes.guild(guildId), Routes.applicationGuildCommands(appId, guildId)]);
  assert.ok(report.checks.every(check => check.state === 'passed'));
});

test('token de outra aplicação bloqueia consulta de comandos no cliente configurado', async () => {
  const routes: string[] = [];
  const report = await verifyRoomsConnections(config(), { roomProvider: () => provider(), discordGet: async route => {
    routes.push(route); return { id: route === Routes.oauth2CurrentApplication() ? '333333333333333333' : guildId };
  } });
  assert.equal(report.connectionsVerified, false);
  assert.ok(report.checks.some(check => check.code === 'DISCORD_APPLICATION_MISMATCH'));
  assert.ok(!routes.includes(Routes.applicationGuildCommands(appId, guildId)));
});

test('comandos ausentes, legados ou com opções divergentes não passam na verificação', async () => {
  const altered = structuredClone(roomCommands);
  const subcommand = altered[0]!.options![1]!;
  assert.ok('options' in subcommand);
  const option = subcommand.options![0]!;
  option.required = false;
  for (const commands of [[], [...roomCommands, { name: 'pix', description: 'legacy' }], altered]) {
    const report = await verifyRoomsConnections(config(), { discordGet: discordGet(commands), roomProvider: () => provider() });
    assert.ok(report.checks.some(check => check.code === 'DISCORD_COMMANDS_DIFFER'));
    assert.equal(report.connectionsVerified, false);
  }
});

test('metadata da API Discord e defaults explícitos não causam falso comando desatualizado', async () => {
  const decorate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decorate);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    // API object ordering differs from the builder; command order itself is irrelevant.
    for (const [key, entry] of Object.entries(object).reverse()) result[key] = decorate(entry);
    if ('description' in result && 'name' in result) {
      if (!('type' in result)) Object.assign(result, { type: 1, id: 'metadata-id', version: 'metadata-version', application_id: appId });
      if (!('required' in result)) result.required = false;
      if (!('autocomplete' in result)) result.autocomplete = false;
    }
    return result;
  };
  const commands = (decorate(roomCommands) as unknown[]).reverse();
  const report = await verifyRoomsConnections(config(), { discordGet: discordGet(commands), roomProvider: () => provider() });
  assert.equal(report.connectionsVerified, true);
});

test('capacidade remota ausente impede aceitar catálogo mesmo se Discord estiver correto', async () => {
  const unsupported = catalog(); unsupported.capabilities.close = false;
  const report = await verifyRoomsConnections(config(), { discordGet: discordGet(), roomProvider: () => provider(unsupported) });
  assert.equal(report.connectionsVerified, false);
  assert.equal(report.checks.find(check => check.id === 'rooms.catalog')?.state, 'failed');
  assert.ok(report.checks.filter(check => check.id.startsWith('discord.')).every(check => check.state === 'passed'));
});

test('simulador não pode certificar conexão real mesmo em configuração api', async () => {
  const report = await verifyRoomsConnections(config(), { discordGet: discordGet(), roomProvider: () => provider(catalog(), 'simulated') });
  assert.equal(report.connectionsVerified, false);
  assert.ok(report.checks.some(check => check.code === 'ROOM_PROVIDER_SIMULATED'));
});

test('falhas de acesso Discord não impedem conferir API e não vazam respostas ou segredos', async () => {
  let catalogReads = 0;
  const api = provider(); api.getCatalog = async () => { catalogReads++; return catalog(); };
  const report = await verifyRoomsConnections(config(), { roomProvider: () => api, discordGet: async () => {
    throw Object.assign(new Error('private-discord-token private-api-key response-body'), { status: 403, requestBody: 'private-payload' });
  } });
  assert.equal(catalogReads, 1);
  assert.equal(report.connectionsVerified, false);
  assert.equal(report.checks.filter(check => check.code === 'DISCORD_ACCESS_DENIED').length, 2);
  assert.ok(report.checks.some(check => check.id === 'rooms.catalog' && check.state === 'passed'));
  assert.doesNotMatch(JSON.stringify(report), /private-|response-body|requestBody|unqueried/);
});

test('falha de catálogo não serializa erro HTTP nem suas credenciais', async () => {
  const report = await verifyRoomsConnections(config(), { discordGet: discordGet(), roomProvider: () => {
    throw new Error('https://unqueried.example private-api-key secret-response-body');
  } });
  assert.equal(report.connectionsVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /private-|secret-response-body|unqueried/);
});

test('CLI sem credenciais termina com falha explícita e não cria banco/configuração', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rooms-verify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'must-not-exist.sqlite');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/rooms/verify.js', import.meta.url))], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DISCORD_TOKEN: '', DISCORD_BOT_TOKEN: '', DISCORD_CLIENT_ID: '', DISCORD_GUILD_ID: '',
      ROOMS_PROVIDER: 'simulated', DATABASE_PATH: databasePath },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.connectionsVerified, false);
  assert.equal(report.homologated, false);
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(join(directory, '.env')), false);
});
