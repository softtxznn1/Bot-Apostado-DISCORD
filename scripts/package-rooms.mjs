import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Explicit allowlist: user configuration, data, builds and credentials are never scanned.
const files = [
  ...['android-inspection', 'commands', 'config', 'demo', 'doctor', 'emulator-doctor', 'health', 'healthcheck', 'http-provider', 'interactions',
    'main', 'operations', 'presentation', 'register', 'runtime', 'service', 'shutdown',
    'simulated-provider', 'types', 'validation', 'verification', 'verify'].map(name => `src/rooms/${name}.ts`),
  ...['backup', 'config', 'database', 'domain', 'outbox'].map(name => `src/${name}.ts`),
  ...['managed-rooms', 'room-provider-v2', 'room-ui', 'room-delivery', 'rooms-entry', 'room-verification',
    'room-health', 'room-operations', 'room-android'].map(name => `tests/${name}.test.ts`),
  'package-lock.json', 'tsconfig.json', '.nvmrc', '.npmrc', '.env.example', '.gitignore', '.dockerignore',
  'Dockerfile', 'GUIA_CLIENTE.md', 'STATUS.md', 'PLANO.md', 'DESENVOLVIMENTO.md', 'PESQUISA.md',
  'docs/DEPLOY.md', 'docs/HOMOLOGACAO.md', 'docs/ROOM_API_V2.md', 'docs/ROOM_AUTOMATION.md', 'docs/VIABILIDADE.md', '.github/workflows/ci.yml',
];
const hash = data => createHash('sha256').update(data).digest('hex');
function source(path) {
  const absolute = join(root, path);
  if (!lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) throw new Error('SOURCE_NOT_REGULAR');
  return readFileSync(absolute);
}
function publish(path, content) {
  try { writeFileSync(path, content, { flag: 'wx', mode: 0o644 }); }
  catch (error) {
    if (error?.code !== 'EEXIST' || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
      || !readFileSync(path).equals(Buffer.from(content))) throw new Error('ARTIFACT_DESTINATION_CONFLICT');
  }
}

function main() {
  const pkg = JSON.parse(source('package.json').toString('utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) throw new Error('PACKAGE_VERSION_INVALID');
  const temporary = mkdtempSync(join(tmpdir(), 'ff-salas-package-'));
  try {
    const staging = join(temporary, 'payload'); mkdirSync(staging, { mode: 0o700 });
    const contents = new Map(files.map(path => [path, source(path)]));
    for (const line of contents.get('.env.example').toString('utf8').split(/\r?\n/)) {
      const assignment = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (assignment && /(?:TOKEN|KEY|SECRET|PASSWORD)$/.test(assignment[1]) && assignment[2].trim()) throw new Error('EXAMPLE_CONTAINS_CREDENTIAL');
    }
    const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([name]) => !name.startsWith('legacy:') && name !== 'package:rooms'));
    contents.set('package.json', Buffer.from(JSON.stringify({ ...pkg, scripts }, null, 2) + '\n'));
    const compose = source('compose.yaml').toString('utf8');
    const dashboard = compose.indexOf('\n  dashboard:\n'); const volumes = compose.indexOf('\nvolumes:\n');
    if (dashboard < 0 || volumes <= dashboard) throw new Error('COMPOSE_LAYOUT_CHANGED');
    contents.set('compose.yaml', Buffer.from(compose.slice(0, dashboard) + compose.slice(volumes)));
    contents.set('README.md', Buffer.from(`# Bot de Salas Free Fire — pacote do cliente

Criação e gerenciamento de salas pelo Discord, com painel, histórico persistente,
controle de cargos e recuperação de falhas. Este pacote contém somente a edição
de salas; os módulos de apostas, pagamentos e dashboard não foram incluídos.

## Instalação em Node.js 24

\`\`\`bash
npm ci
npm run verify:local
\`\`\`

O pacote inclui apenas os testes de salas. Contagens da base completa em STATUS.md
se referem ao repositório original. A validação local usa salas de demonstração.

Configure as variáveis seguras de .env.example. Antes de executar no Discord,
confira aplicação e servidor: npm run register substitui os comandos desta
aplicação nesse servidor. Após registro: npm run verify:connections e npm start.

## Documentação e integridade

- [Guia de uso](GUIA_CLIENTE.md)
- [Execução e permissões](DESENVOLVIMENTO.md)
- [Hospedagem e backup](docs/DEPLOY.md)
- [Aceite com serviços reais](docs/HOMOLOGACAO.md)
- [Contrato da API](docs/ROOM_API_V2.md)
- [API ou executor com emulador](docs/ROOM_AUTOMATION.md)
- [Custos, caminho recomendado e PIX avulso](docs/VIABILIDADE.md)
- Verifique os arquivos extraídos com \`sha256sum -c MANIFEST.sha256\`.

O backend real (API ou executor próprio) ainda precisa ser validado. Sem credenciais
e homologação no Discord e Free Fire, este pacote não representa aceite de produção.
Referências aos módulos legados nos documentos descrevem o repositório original.
`));
    contents.set('RELEASE.json', Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version,
      edition: 'rooms', included: 'source-and-room-tests', node: pkg.engines.node,
      validationCommand: 'npm run verify:local', localValidation: 'passed', supplierIntegrationConfirmed: false,
      emulatorAutomationImplemented: false, liveDiscordValidated: false, liveFreeFireValidated: false,
    }, null, 2) + '\n'));
    const manifest = [...contents].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, data]) => `${hash(data)}  ${path}`).join('\n') + '\n';
    contents.set('MANIFEST.sha256', Buffer.from(manifest));
    for (const [path, data] of contents) {
      const destination = join(staging, path); mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      writeFileSync(destination, data, { flag: 'wx', mode: 0o644 });
    }
    // Validate the exact reduced source tree, not only the original repository.
    console.log('Validando a instalação isolada da edição de salas...');
    for (const args of [['ci', '--include=dev', '--no-audit', '--no-fund', '--cache', join(root, '.cache', 'npm')], ['run', 'verify:local']]) {
      const check = spawnSync('npm', args, { cwd: staging, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      if (check.status !== 0) throw new Error('CLIENT_VALIDATION_FAILED');
    }
    for (const [path, data] of contents) if (!readFileSync(join(staging, path)).equals(data)) throw new Error('CLIENT_SOURCE_CHANGED');
    const tarPath = join(temporary, 'payload.tar');
    const tar = spawnSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=0644',
      '-cf', tarPath, '-C', staging, '--', ...[...contents.keys()].sort()], { encoding: 'utf8', timeout: 30_000 });
    if (tar.status !== 0) throw new Error('GNU_TAR_REQUIRED');
    const archive = gzipSync(readFileSync(tarPath), { level: 9 }); const digest = hash(archive);
    const directory = join(root, 'artifacts');
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o755 });
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error('ARTIFACT_DIRECTORY_INVALID');
    const name = `bot-salas-${pkg.version}-${digest.slice(0, 12)}.tar.gz`;
    publish(join(directory, name), archive);
    publish(join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
    console.log(JSON.stringify({ artifact: `artifacts/${name}`, sha256: digest, files: contents.size,
      bytes: archive.length, privateConfigurationIncluded: false, clientValidationPassed: true, liveValidated: false }, null, 2));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
try { main(); }
catch { console.error('Falha ao empacotar. Confira os arquivos permitidos, GNU tar e o diretório artifacts; nenhum destino existente será sobrescrito.'); process.exitCode = 1; }
