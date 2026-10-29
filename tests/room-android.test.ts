import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAndroidEnvironment, type AndroidInspectionRunner } from '../src/rooms/android-inspection.js';

const serial = 'private-device-5554';
const listing = (rows = `${serial}\tdevice product:PRIVATE_PRODUCT model:PRIVATE_MODEL transport_id:7`) => `List of devices attached\n${rows}\n`;
function fixture(overrides: { devices?: string; boot?: string; app?: string; display?: string; failure?: string } = {}) {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const runner: AndroidInspectionRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    const command = args.join(' ');
    if (overrides.failure && command.includes(overrides.failure)) throw new Error('PRIVATE_EXECUTABLE_PATH PRIVATE_DEVICE_PASSWORD PRIVATE_STDERR');
    if (command === 'version') return 'Android Debug Bridge version 1.0.41\nInstalled as PRIVATE_EXECUTABLE_PATH\n';
    if (command === 'devices -l') return overrides.devices ?? listing();
    if (command.endsWith('shell getprop sys.boot_completed')) return overrides.boot ?? '1\n';
    if (command.includes('shell pm path ')) return overrides.app ?? 'package:/data/app/PRIVATE_USER_DATA/base.apk\n';
    if (command.endsWith('shell wm size')) return overrides.display ?? 'Physical size: 1080x1920\nOverride size: 720x1280\n';
    assert.fail('Unexpected or mutating ADB command.');
  };
  return { calls, runner };
}
const state = (report: Awaited<ReturnType<typeof inspectAndroidEnvironment>>, id: string) => report.checks.find(check => check.id === `android.${id}`);

test('ADB ausente retorna bloqueios sem expor erro ou carregar configuração de pagamentos', async () => {
  let calls = 0;
  const report = await inspectAndroidEnvironment({ PAYMENT_PROVIDER: 'efi', EFI_CERT_FILE: '/private-certificate', ROOMS_PROVIDER: 'api' }, async () => {
    calls++; throw Object.assign(new Error('PRIVATE_ADB_PATH PRIVATE_STDERR'), { code: 'ENOENT' });
  });
  assert.equal(calls, 1); assert.equal(report.readyForInspection, false);
  assert.equal(state(report, 'adb')?.code, 'ANDROID_ADB_MISSING');
  assert.equal(report.checks.length, 6);
  assert.ok(report.checks.slice(2).every(check => check.state === 'blocked'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|private-certificate/);
});

test('Android disponível autoriza somente cinco consultas e não certifica automação ou salas', async () => {
  const f = fixture(); const report = await inspectAndroidEnvironment({}, f.runner);
  assert.equal(report.readyForInspection, true); assert.equal(report.readOnly, true);
  assert.equal(report.emulatorAutomationImplemented, false); assert.equal(report.realRoomsVerified, false);
  assert.deepEqual(f.calls.map(call => call.args), [
    ['version'], ['devices', '-l'], ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
    ['-s', serial, 'shell', 'pm', 'path', 'com.dts.freefireth'], ['-s', serial, 'shell', 'wm', 'size'],
  ]);
  assert.ok(f.calls.every(call => call.executable === 'adb'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|private-device|5554|\/data\/|1080|1920/);
});

test('vários dispositivos exigem seleção explícita antes de consultar qualquer Android', async () => {
  const f = fixture({ devices: listing(`${serial}\tdevice\nother-private-device\tdevice`) });
  const report = await inspectAndroidEnvironment({}, f.runner);
  assert.equal(state(report, 'device')?.code, 'ANDROID_DEVICE_SELECTION_REQUIRED');
  assert.equal(f.calls.length, 2); assert.equal(report.readyForInspection, false);
});

test('seleção explícita consulta só o alvo autorizado e aceita Free Fire MAX', async () => {
  const f = fixture({ devices: listing(`${serial}\tdevice\nother-private-device\tunauthorized`) });
  const report = await inspectAndroidEnvironment({ ROOMS_ANDROID_SERIAL: serial, ROOMS_ANDROID_PACKAGE: 'com.dts.freefiremax' }, f.runner);
  assert.equal(report.readyForInspection, true);
  assert.ok(f.calls.slice(2).every(call => call.args[1] === serial));
  assert.deepEqual(f.calls[3]!.args, ['-s', serial, 'shell', 'pm', 'path', 'com.dts.freefiremax']);
  assert.doesNotMatch(JSON.stringify(report), /private-device|other-private|5554/);
});

test('alvo configurado ausente não usa outro dispositivo como fallback', async () => {
  const f = fixture(); const report = await inspectAndroidEnvironment({ ROOMS_ANDROID_SERIAL: 'missing-device' }, f.runner);
  assert.equal(state(report, 'device')?.code, 'ANDROID_SELECTED_DEVICE_MISSING');
  assert.equal(f.calls.length, 2); assert.equal(report.readyForInspection, false);
});

test('Android offline, não autorizado ou sem dispositivo bloqueia todas as consultas seguintes', async () => {
  for (const devices of [listing(`${serial}\toffline`), listing(`${serial}\tunauthorized`), listing('')]) {
    const f = fixture({ devices }); const report = await inspectAndroidEnvironment({}, f.runner);
    assert.equal(report.readyForInspection, false); assert.equal(state(report, 'device')?.state, 'blocked');
    assert.equal(f.calls.length, 2);
  }
});

test('inicialização incompleta não tenta consultar jogo nem resolução', async () => {
  const f = fixture({ boot: '0\n' }); const report = await inspectAndroidEnvironment({}, f.runner);
  assert.equal(state(report, 'boot')?.code, 'ANDROID_BOOT_INCOMPLETE');
  assert.equal(f.calls.length, 3);
  assert.equal(state(report, 'app')?.state, 'blocked'); assert.equal(state(report, 'display')?.state, 'blocked');
});

test('jogo ausente mantém resolução consultável sem indicar dispositivo pronto para inspeção', async () => {
  const f = fixture({ app: '' }); const report = await inspectAndroidEnvironment({}, f.runner);
  assert.equal(state(report, 'app')?.code, 'ANDROID_GAME_MISSING');
  assert.equal(state(report, 'display')?.state, 'passed'); assert.equal(report.readyForInspection, false);
  assert.equal(f.calls.length, 5);
});

test('configuração inválida não vira argumento shell nem executa ADB', async () => {
  for (const env of [{ ROOMS_ANDROID_PACKAGE: 'com.dts.freefireth;input tap 1 1' }, { ROOMS_ANDROID_SERIAL: 'device\nprivate' },
    { ROOMS_ADB_PATH: 'private\ncommand' }, { ROOMS_ADB_PATH: '   ' }]) {
    let calls = 0; const report = await inspectAndroidEnvironment(env, async () => { calls++; return ''; });
    assert.equal(calls, 0); assert.equal(state(report, 'config')?.code, 'ANDROID_CONFIG_INVALID');
    assert.equal(report.readyForInspection, false); assert.doesNotMatch(JSON.stringify(report), /input tap|private/);
  }
});

test('resoluções inválidas e caminho de pacote inconsistente não passam no diagnóstico', async () => {
  for (const display of ['Physical size: 0x1920', 'Physical size: 1080x99999999', 'Physical size: 1080x1920\nOverride size: PRIVATE_DATA', 'PRIVATE_RAW_OUTPUT']) {
    const f = fixture({ display }); const report = await inspectAndroidEnvironment({}, f.runner);
    assert.equal(state(report, 'display')?.state, 'failed'); assert.equal(report.readyForInspection, false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  }
  const f = fixture({ app: 'Error: PRIVATE_RAW_OUTPUT' }); const report = await inspectAndroidEnvironment({}, f.runner);
  assert.equal(state(report, 'app')?.code, 'ANDROID_GAME_RESPONSE_INVALID'); assert.equal(report.readyForInspection, false);
});

test('falhas de boot, aplicação e resolução são estáticas e não divulgam stderr ou caminhos', async () => {
  for (const failure of ['sys.boot_completed', 'pm path', 'wm size']) {
    const f = fixture({ failure }); const report = await inspectAndroidEnvironment({}, f.runner);
    assert.equal(report.readyForInspection, false); assert.ok(report.checks.some(check => check.state === 'failed'));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|private-device|\/data\//);
    if (failure === 'sys.boot_completed') assert.equal(f.calls.length, 3);
  }
});

test('lista malformada, serial duplicado ou resposta excessiva são recusados antes de escolher alvo', async () => {
  for (const devices of ['PRIVATE_INVALID_HEADER', listing(`${serial}\tdevice\n${serial}\tdevice`), listing('PRIVATE_SERIAL_WITHOUT_STATE'), 'x'.repeat(16 * 1024 + 1)]) {
    const f = fixture({ devices }); const report = await inspectAndroidEnvironment({}, f.runner);
    assert.equal(report.readyForInspection, false); assert.equal(state(report, 'device')?.state, 'failed');
    assert.equal(f.calls.length, 2); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  }
});

test('execução real aceita caminho com espaços sem invocar shell', async t => {
  if (process.platform === 'win32') { t.skip('Fixture executável usa shebang POSIX; ADB do Windows utiliza adb.exe.'); return; }
  const directory = temporary(t); const executable = join(directory, 'adb with spaces');
  const script = `#!${process.execPath}\nconst a=process.argv.slice(2).join(' ');if(a==='version')console.log('Android Debug Bridge version 1.0.41');else if(a==='devices -l')console.log('List of devices attached\\nprivate-device-5554\\tdevice');else if(a.endsWith('sys.boot_completed'))console.log('1');else if(a.includes('pm path'))console.log('package:/data/app/private/base.apk');else if(a.endsWith('wm size'))console.log('Physical size: 1080x1920');else process.exit(2);\n`;
  writeFileSync(executable, script, { mode: 0o700 }); chmodSync(executable, 0o700);
  const report = await inspectAndroidEnvironment({ ROOMS_ADB_PATH: executable });
  assert.equal(report.readyForInspection, true);
  assert.doesNotMatch(JSON.stringify(report), /adb with spaces|private-device|\/data\/app/);
});

test('CLI bloqueada é independente de Discord/financeiro e não cria banco nem configuração', t => {
  const directory = temporary(t); const database = join(directory, 'must-not-exist.sqlite');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/rooms/emulator-doctor.js', import.meta.url))], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ROOMS_ADB_PATH: join(directory, 'missing-private-adb'), DATABASE_PATH: database,
      ROOMS_ANDROID_SERIAL: '', ROOMS_ANDROID_PACKAGE: 'com.dts.freefireth', ROOMS_PROVIDER: 'api', ROOMS_API_CONTRACT: '',
      PAYMENT_PROVIDER: 'efi', EFI_CERT_FILE: '/private-certificate', DISCORD_TOKEN: '' },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true); assert.equal(report.readyForInspection, false);
  assert.equal(report.emulatorAutomationImplemented, false); assert.equal(report.realRoomsVerified, false);
  assert.equal(state(report, 'adb')?.code, 'ANDROID_ADB_MISSING');
  assert.equal(existsSync(database), false); assert.equal(existsSync(join(directory, '.env')), false);
  assert.doesNotMatch(result.stdout, /missing-private-adb|private-certificate/);
});

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'rooms-android-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
