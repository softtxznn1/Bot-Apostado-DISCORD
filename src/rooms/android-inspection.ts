import { execFile } from 'node:child_process';

export type AndroidInspectionRunner = (executable: string, args: readonly string[]) => Promise<string>;
type Check = { id: string; state: 'passed' | 'blocked' | 'failed'; code: string; message: string };
export type AndroidInspectionReport = {
  edition: 'rooms'; target: 'android'; readOnly: true; readyForInspection: boolean;
  emulatorAutomationImplemented: false; realRoomsVerified: false; checks: Check[];
};

const maxOutputBytes = 16 * 1024;
const checkIds = ['android.config', 'android.adb', 'android.device', 'android.boot', 'android.app', 'android.display'] as const;
const gamePackages = new Set(['com.dts.freefireth', 'com.dts.freefiremax']);
const serialValid = (value: string): boolean => /^[!-~]{1,256}$/.test(value) && !value.startsWith('-');

/** No shell, remote connection, input event, installation or game mutation is allowed. */
const executeAdb: AndroidInspectionRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { shell: false, windowsHide: true, timeout: 5000,
    maxBuffer: maxOutputBytes, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

function devicesFrom(output: string): { serial: string; state: string }[] | undefined {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const header = lines.indexOf('List of devices attached');
  if (header < 0) return undefined;
  const devices: { serial: string; state: string }[] = [];
  for (const line of lines.slice(header + 1).filter(Boolean)) {
    const [serial, state] = line.split(/\s+/);
    if (!serial || !serialValid(serial) || !state || devices.some(device => device.serial === serial)) return undefined;
    devices.push({ serial, state });
  }
  return devices;
}
function screenSizeValid(output: string): boolean {
  const physical = output.match(/^Physical size:\s*(\d+)x(\d+)\s*$/m);
  const override = output.match(/^Override size:\s*(\d+)x(\d+)\s*$/m);
  const valid = (match: RegExpMatchArray | null) => !!match && [match[1], match[2]].every(value => {
    const number = Number(value); return Number.isSafeInteger(number) && number >= 2 && number <= 16_384;
  });
  return valid(physical) && (!output.includes('Override size:') || valid(override));
}

/** Checks Android prerequisites only; no provider or room automation is initialized. */
export async function inspectAndroidEnvironment(env: NodeJS.ProcessEnv = process.env,
  runner: AndroidInspectionRunner = executeAdb): Promise<AndroidInspectionReport> {
  const checks: Check[] = [];
  const add = (id: string, state: Check['state'], code: string, message: string) => checks.push({ id, state, code, message });
  const finish = (): AndroidInspectionReport => {
    for (const id of checkIds) if (!checks.some(check => check.id === id)) add(id, 'blocked', 'ANDROID_PREREQUISITE_BLOCKED', 'Uma verificação anterior precisa ser resolvida antes desta consulta.');
    return { edition: 'rooms', target: 'android', readOnly: true, readyForInspection: checks.every(check => check.state === 'passed'),
      emulatorAutomationImplemented: false, realRoomsVerified: false, checks };
  };
  const executable = env.ROOMS_ADB_PATH || 'adb'; const configuredSerial = env.ROOMS_ANDROID_SERIAL || undefined;
  const gamePackage = env.ROOMS_ANDROID_PACKAGE || 'com.dts.freefireth';
  if (!executable.trim() || executable.length > 4096 || /[\u0000-\u001f\u007f]/.test(executable)
    || (configuredSerial !== undefined && !serialValid(configuredSerial)) || !gamePackages.has(gamePackage)) {
    add('android.config', 'failed', 'ANDROID_CONFIG_INVALID', 'Confira o executável ADB, a seleção do dispositivo e o pacote oficial Free Fire ou Free Fire MAX.'); return finish();
  }
  add('android.config', 'passed', 'ANDROID_CONFIG_OK', 'Configuração aceita para consultas de diagnóstico, sem comandos de jogo.');
  const read = async (args: readonly string[]): Promise<string> => {
    const output = await runner(executable, args);
    if (typeof output !== 'string' || Buffer.byteLength(output) > maxOutputBytes) throw new Error('ANDROID_OUTPUT_INVALID');
    return output;
  };
  try {
    const version = await read(['version']);
    if (!/^Android Debug Bridge version \d+\.\d+\.\d+\b/m.test(version)) {
      add('android.adb', 'failed', 'ANDROID_ADB_RESPONSE_INVALID', 'O executável não confirmou uma versão reconhecível do Android Debug Bridge.'); return finish();
    }
    add('android.adb', 'passed', 'ANDROID_ADB_OK', 'O Android Debug Bridge respondeu ao diagnóstico local.');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    add('android.adb', missing ? 'blocked' : 'failed', missing ? 'ANDROID_ADB_MISSING' : 'ANDROID_ADB_FAILED',
      'Não foi possível executar o Android Debug Bridge. Configure as ferramentas Android no computador responsável pelo emulador.'); return finish();
  }
  let devices: ReturnType<typeof devicesFrom>;
  try { devices = devicesFrom(await read(['devices', '-l'])); }
  catch { add('android.device', 'failed', 'ANDROID_DEVICE_QUERY_FAILED', 'A lista de dispositivos Android não pôde ser consultada.'); return finish(); }
  if (!devices) {
    add('android.device', 'failed', 'ANDROID_DEVICE_RESPONSE_INVALID', 'A lista de dispositivos retornada pelo ADB não pôde ser validada.'); return finish();
  }
  if (!devices.length) {
    add('android.device', 'blocked', 'ANDROID_DEVICE_MISSING', 'Nenhum dispositivo Android foi encontrado no ADB deste computador.'); return finish();
  }
  if (!configuredSerial && devices.length !== 1) {
    add('android.device', 'blocked', 'ANDROID_DEVICE_SELECTION_REQUIRED', 'Há vários dispositivos Android. Configure ROOMS_ANDROID_SERIAL para selecionar um deles explicitamente.'); return finish();
  }
  const selected = configuredSerial ? devices.find(device => device.serial === configuredSerial) : devices[0];
  if (!selected) {
    add('android.device', 'blocked', 'ANDROID_SELECTED_DEVICE_MISSING', 'O dispositivo configurado não foi encontrado. Confira a seleção no computador do emulador.'); return finish();
  }
  if (selected.state !== 'device') {
    add('android.device', 'blocked', 'ANDROID_DEVICE_UNAVAILABLE', 'O dispositivo selecionado está indisponível ou não autorizou o ADB. Resolva a conexão e a autorização no próprio dispositivo.'); return finish();
  }
  add('android.device', 'passed', 'ANDROID_DEVICE_OK', 'Um dispositivo Android autorizado foi selecionado para as consultas.');
  const shell = (args: readonly string[]) => read(['-s', selected.serial, 'shell', ...args]);
  try {
    if ((await shell(['getprop', 'sys.boot_completed'])).trim() !== '1') {
      add('android.boot', 'blocked', 'ANDROID_BOOT_INCOMPLETE', 'O Android ainda não confirmou a conclusão da inicialização.'); return finish();
    }
    add('android.boot', 'passed', 'ANDROID_BOOT_OK', 'O Android confirmou a conclusão da inicialização.');
  } catch { add('android.boot', 'failed', 'ANDROID_BOOT_QUERY_FAILED', 'Não foi possível consultar a inicialização do Android.'); return finish(); }
  try {
    const output = (await shell(['pm', 'path', gamePackage])).trim();
    if (!output) add('android.app', 'blocked', 'ANDROID_GAME_MISSING', 'O pacote selecionado do Free Fire não está instalado no dispositivo.');
    else if (!output.split(/\r?\n/).every(line => /^package:\/[^\u0000-\u001f\u007f]+\.apk$/.test(line))) {
      add('android.app', 'failed', 'ANDROID_GAME_RESPONSE_INVALID', 'O Android não confirmou a instalação do pacote selecionado do jogo.');
    } else add('android.app', 'passed', 'ANDROID_GAME_INSTALLED', 'O Android confirmou a instalação do pacote selecionado do jogo. A conta e as funcionalidades de sala não foram verificadas.');
  } catch { add('android.app', 'failed', 'ANDROID_GAME_QUERY_FAILED', 'Não foi possível consultar a instalação do pacote selecionado do jogo.'); }
  try {
    if (!screenSizeValid(await shell(['wm', 'size']))) add('android.display', 'failed', 'ANDROID_DISPLAY_RESPONSE_INVALID', 'Não foi possível validar a resolução informada pelo Android.');
    else add('android.display', 'passed', 'ANDROID_DISPLAY_OK', 'O Android informou uma resolução válida para uma futura inspeção visual. Nenhuma imagem foi capturada.');
  } catch { add('android.display', 'failed', 'ANDROID_DISPLAY_QUERY_FAILED', 'Não foi possível consultar a resolução do Android.'); }
  return finish();
}
