import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/database.js';
import { checkRoomsDatabase, checkRoomsHealth, RoomsHealthMonitor } from '../src/rooms/health.js';
import { ManagedRoomsService } from '../src/rooms/service.js';
import { SimulatedManagedRoomProvider } from '../src/rooms/simulated-provider.js';
import { createRoomsShutdown } from '../src/rooms/shutdown.js';

function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rooms-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'health.json') };
}

test('heartbeat usa banco real, escrita atômica privada e não certifica salas no jogo', t => {
  const { file } = fixture(t); const store = new Store(':memory:'); t.after(() => store.close());
  const monitor = new RoomsHealthMonitor({ file, now: () => 100_000, discordReady: () => true,
    checkDatabase: () => { store.db.prepare('SELECT 1').get(); }, onError: error => { throw error; } });
  monitor.sample();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(checkRoomsHealth(file, 100_000), { healthy: true, reason: 'HEALTH_OK', liveRoomsVerified: false });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['checkedAt', 'databaseOk', 'discordReady', 'pid', 'version']);
  monitor.stop(); assert.equal(existsSync(file), false);
});

test('queda Discord e banco fechado produzem falha explícita no indicador local', t => {
  const { file } = fixture(t); const store = new Store(':memory:'); let ready = false;
  const monitor = new RoomsHealthMonitor({ file, now: () => 100_000, discordReady: () => ready,
    checkDatabase: () => { store.db.prepare('SELECT 1').get(); }, onError: error => { throw error; } });
  monitor.sample(); assert.equal(checkRoomsHealth(file, 100_000).reason, 'HEALTH_DISCORD_DISCONNECTED');
  ready = true; monitor.sample(); assert.equal(checkRoomsHealth(file, 100_000).healthy, true);
  store.close(); monitor.sample(); assert.equal(checkRoomsHealth(file, 100_000).reason, 'HEALTH_DATABASE_UNAVAILABLE');
  monitor.stop();
});

test('probe detecta SQLite sem escrita e não altera salas ou eventos existentes', async t => {
  const { file } = fixture(t); const store = new Store(':memory:'); t.after(() => store.close());
  const service = new ManagedRoomsService(store, new SimulatedManagedRoomProvider(store));
  const actor = { userId: 'owner', administrator: true, roleIds: [] };
  await service.configure({ guildId: 'guild', panelChannelId: 'panel', outputChannelId: 'output', logChannelId: null,
    operatorRoleIds: [], managerRoleIds: [], viewerRoleIds: [], allowedModeIds: [], allowedMapIds: [],
    maxActivePerUser: 5, maxActivePerGuild: 10, cooldownSeconds: 0 }, actor);
  const room = await service.createDraft('guild', actor, { name: 'Health probe', modeId: 'demo-standard', mapId: 'demo-island', maxPlayers: 10, extras: {} });
  const before = JSON.stringify({ room: service.get('guild', room.id, actor), events: service.events('guild', room.id, actor) });
  const monitor = new RoomsHealthMonitor({ file, discordReady: () => true, checkDatabase: () => checkRoomsDatabase(store.db), onError: error => { throw error; } });
  monitor.sample(); assert.equal(checkRoomsHealth(file).healthy, true);
  store.db.exec('PRAGMA query_only=ON');
  monitor.sample(); assert.equal(checkRoomsHealth(file).reason, 'HEALTH_DATABASE_UNAVAILABLE');
  store.db.exec('PRAGMA query_only=OFF');
  monitor.sample(); assert.equal(checkRoomsHealth(file).healthy, true);
  assert.equal(JSON.stringify({ room: service.get('guild', room.id, actor), events: service.events('guild', room.id, actor) }), before);
  monitor.stop();
});

test('heartbeat vencido, no futuro ou de processo encerrado nunca aparece saudável', t => {
  const { file } = fixture(t);
  const monitor = new RoomsHealthMonitor({ file, now: () => 100_000, discordReady: () => true, checkDatabase: () => {}, onError: error => { throw error; } });
  monitor.sample();
  assert.equal(checkRoomsHealth(file, 135_001).reason, 'HEALTH_HEARTBEAT_STALE');
  assert.equal(checkRoomsHealth(file, 99_999).reason, 'HEALTH_HEARTBEAT_STALE');
  assert.equal(checkRoomsHealth(file, 100_000, () => false).reason, 'HEALTH_PROCESS_STOPPED');
  monitor.stop();
});

test('arquivo inválido, grande ou simbólico não expõe conteúdo nem indica saúde', t => {
  const { directory, file } = fixture(t);
  for (const value of ['private-secret-body', JSON.stringify({ pid: process.pid }), 'x'.repeat(4097)]) {
    writeFileSync(file, value);
    const report = checkRoomsHealth(file);
    assert.equal(report.healthy, false); assert.doesNotMatch(JSON.stringify(report), /private-secret-body/);
  }
  const target = join(directory, 'target.json');
  writeFileSync(target, JSON.stringify({ version: 1, pid: process.pid, checkedAt: Date.now(), discordReady: true, databaseOk: true }));
  rmSync(file); symlinkSync(target, file);
  assert.equal(checkRoomsHealth(file).healthy, false);
});

test('monitor mantém um timer, para de escrever e preserva arquivo de outro processo', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  const { file } = fixture(t); let samples = 0;
  const monitor = new RoomsHealthMonitor({ file, discordReady: () => true, checkDatabase: () => { samples++; }, onError: error => { throw error; } });
  monitor.start(); monitor.start(); assert.equal(samples, 1);
  t.mock.timers.tick(10_000); assert.equal(samples, 2);
  writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid + 1, checkedAt: Date.now(), discordReady: true, databaseOk: true }));
  monitor.stop(); t.mock.timers.tick(30_000);
  assert.equal(samples, 2); assert.equal(existsSync(file), true);
});

test('arquivo FIFO no lugar do heartbeat não bloqueia a verificação nem o encerramento', t => {
  const { file } = fixture(t);
  const fifo = spawnSync('mkfifo', [file], { encoding: 'utf8' }); assert.equal(fifo.status, 0);
  const command = fileURLToPath(new URL('../src/rooms/healthcheck.js', import.meta.url));
  const result = spawnSync(process.execPath, [command], {
    encoding: 'utf8', timeout: 1000, env: { ...process.env, ROOMS_HEALTH_FILE: file },
  });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).healthy, false);
  const monitor = new RoomsHealthMonitor({ file, discordReady: () => false, checkDatabase: () => {}, onError: error => { throw error; } });
  monitor.stop();
});

test('CLI de saúde funciona compilada sem dependências de desenvolvimento nem serviços externos', t => {
  const { file } = fixture(t);
  const command = fileURLToPath(new URL('../src/rooms/healthcheck.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [command], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ROOMS_HEALTH_FILE: file } });
  const missing = run(); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).healthy, false);
  const monitor = new RoomsHealthMonitor({ file, discordReady: () => true, checkDatabase: () => {}, onError: error => { throw error; } });
  monitor.sample();
  const healthy = run(); assert.equal(healthy.status, 0); assert.equal(JSON.parse(healthy.stdout).liveRoomsVerified, false);
  monitor.stop(); assert.equal(run().status, 1);
});

test('encerramento concorrente retira saúde antes de esperar trabalho e fecha banco somente no final', async () => {
  const store = new Store(':memory:'); let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const steps: string[] = [];
  const close = createRoomsShutdown({ stopHealth: () => { steps.push('health'); }, stopWork: async () => {
    steps.push('waiting'); await work; store.db.prepare('SELECT 1').get(); steps.push('work_done');
  }, destroyClient: async () => { steps.push('discord'); }, closeStore: () => { store.close(); steps.push('database'); },
  onError: error => { throw error; }, forceExit: assert.fail });
  const first = close(); const second = close(); assert.equal(first, second);
  await Promise.resolve(); assert.deepEqual(steps, ['health', 'waiting']);
  store.db.prepare('SELECT 1').get(); finish(); await first;
  assert.deepEqual(steps, ['health', 'waiting', 'work_done', 'discord', 'database']);
  assert.throws(() => store.db.prepare('SELECT 1'));
});

test('encerramento com falha no trabalho não fecha banco enquanto podem existir operações em voo', async () => {
  const store = new Store(':memory:'); let forced = 0; const errors: unknown[] = [];
  const close = createRoomsShutdown({ stopHealth: () => {}, stopWork: async () => { throw new Error('stopped unexpectedly'); },
    destroyClient: async () => { assert.fail('Client must not be destroyed before work is stopped.'); },
    closeStore: () => { assert.fail('Store must remain open until work is stopped.'); }, onError: error => { errors.push(error); }, forceExit: () => { forced++; } });
  await assert.rejects(close()); assert.equal(forced, 1); assert.equal(errors.length, 1);
  store.db.prepare('SELECT 1').get(); store.close();
});

test('prazo de encerramento força saída sem fechar SQLite por baixo de operações pendentes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void; let closed = false; let forced = 0; const errors: unknown[] = [];
  const work = new Promise<void>(resolve => { finish = resolve; });
  const close = createRoomsShutdown({ timeoutMs: 1000, stopHealth: () => {}, stopWork: () => work,
    destroyClient: async () => {}, closeStore: () => { closed = true; },
    onError: error => { errors.push(error); }, forceExit: () => { forced++; } });
  const pending = close(); await Promise.resolve();
  t.mock.timers.tick(1000); assert.equal(forced, 1); assert.equal(closed, false); assert.equal(errors.length, 1);
  finish(); await pending;
});
