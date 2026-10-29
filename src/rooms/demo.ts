import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../database.js';
import { reportError } from '../config.js';
import { ManagedRoomsService } from './service.js';
import { SimulatedManagedRoomProvider } from './simulated-provider.js';
import type { RoomActor, RoomOptions, RoomSettings } from './types.js';

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'discord-rooms-demo-'));
  const filename = join(directory, 'rooms.sqlite');
  let store = new Store(filename);
  try {
    const provider = new SimulatedManagedRoomProvider(store);
    let service = new ManagedRoomsService(store, provider);
    const admin: RoomActor = { userId: '11111111111111111', roleIds: [], administrator: true };
    const operator: RoomActor = { userId: '22222222222222222', roleIds: ['33333333333333333'], administrator: false };
    const settings: RoomSettings = {
      guildId: '44444444444444444', panelChannelId: '55555555555555555', outputChannelId: '66666666666666666', logChannelId: null,
      operatorRoleIds: ['33333333333333333'], managerRoleIds: [], viewerRoleIds: [],
      allowedModeIds: [], allowedMapIds: [], maxActivePerUser: 5, maxActivePerGuild: 20, cooldownSeconds: 0,
    };
    await service.configure(settings, admin);
    const catalog = await service.catalog(settings.guildId, operator);
    const mode = catalog.modes[0]!;
    const options: RoomOptions = { name: 'Sala de demonstração', modeId: mode.id, mapId: mode.mapIds[0]!,
      maxPlayers: Math.min(10, mode.maxPlayers), password: 'DEMO123', extras: { rounds: 3, friendlyFire: false, loot: 'normal' } };
    const draft = await service.createDraft(settings.guildId, operator, options);
    const created = await service.create(settings.guildId, draft.id, operator);
    assert.equal(created.state, 'ready'); assert.equal(created.source, 'simulated');
    assert.equal(created.confirmed?.maxPlayers, 10);
    await service.update(settings.guildId, created.id, operator, { ...options, name: 'Sala atualizada', maxPlayers: 12 });
    const synced = await service.synchronize(settings.guildId, created.id, operator);
    assert.equal(synced.confirmed?.maxPlayers, 12);
    assert.equal((await service.close(settings.guildId, created.id, operator, 'Encerrada no teste local.')).state, 'closed');
    const another = await service.createDraft(settings.guildId, operator, { ...options, name: 'Segunda sala' });
    await service.create(settings.guildId, another.id, operator);
    assert.equal((await service.cancel(settings.guildId, another.id, operator, 'Cancelamento no teste local.')).state, 'cancelled');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM matches').get()?.count, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM queues').get()?.count, 0);
    store.close(); store = new Store(filename);
    service = new ManagedRoomsService(store, new SimulatedManagedRoomProvider(store));
    assert.equal(service.get(settings.guildId, created.id, operator).state, 'closed');
    assert.equal(service.list(settings.guildId, operator).total, 2);
    assert.ok(service.events(settings.guildId, created.id, operator).length >= 4);
    console.log('SIMULAÇÃO: configurar → modo/mapa/capacidade → criar → consultar → atualizar → encerrar/cancelar.');
    console.log('Salas e histórico preservados após reinício. Nenhuma partida, fila ou pagamento foi criado.');
    console.log('Nenhuma conexão ao Discord ou Free Fire. Os dados pertencem a um provedor de demonstração.');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { reportError(error, 'rooms_demo'); process.exitCode = 1; });
