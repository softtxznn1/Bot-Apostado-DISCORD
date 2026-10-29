import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export class BackupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BackupError'; }
}

export type BackupResult = { destination: string; pages: number };

/** Snapshot consistente incluindo WAL; nunca publica sobre um destino existente. */
export async function backupDatabase(source: string, destination: string): Promise<BackupResult> {
  const sourcePath = resolve(source);
  let sourceInfo;
  try { sourceInfo = lstatSync(sourcePath); }
  catch { throw new BackupError('SOURCE_MISSING', 'Banco de origem não encontrado; nenhum banco foi criado.'); }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new BackupError('SOURCE_INVALID', 'A origem precisa ser um arquivo SQLite regular, sem link simbólico.');
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath) throw new BackupError('SAME_FILE', 'O destino não pode ser o banco de origem.');
  try {
    lstatSync(destinationPath);
    throw new BackupError('DESTINATION_EXISTS', 'O destino já existe; escolha um novo nome para preservar o backup anterior.');
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new BackupError('DESTINATION_INVALID', 'Não foi possível verificar o destino do backup.');
  }
  const parent = dirname(destinationPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== resolve(parent)) throw new BackupError('DESTINATION_INVALID', 'O diretório do backup não pode conter links simbólicos.');
  const temporaryDir = mkdtempSync(join(parent, '.backup-'));
  chmodSync(temporaryDir, 0o700);
  const temporaryFile = join(temporaryDir, 'snapshot.sqlite');
  let sourceDb: DatabaseSync | undefined;
  try {
    closeSync(openSync(temporaryFile, 'wx', 0o600));
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    sourceDb.exec('PRAGMA busy_timeout=5000;');
    const pages = await backup(sourceDb, temporaryFile);
    const snapshot = new DatabaseSync(temporaryFile, { readOnly: true });
    try {
      const result = snapshot.prepare('PRAGMA integrity_check').all();
      if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new BackupError('INTEGRITY_FAILED', 'A verificação de integridade do backup falhou; o destino não foi publicado.');
    } finally { snapshot.close(); }
    chmodSync(temporaryFile, 0o600);
    const file = openSync(temporaryFile, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    // link() publica atomicamente e falha com EEXIST se outro processo criou o destino.
    // rename() simples poderia sobrescrever um backup criado durante esta execução.
    try { linkSync(temporaryFile, destinationPath); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new BackupError('DESTINATION_EXISTS', 'O destino foi criado por outro processo; ele foi preservado.');
      throw error;
    }
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { destination: destinationPath, pages };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('BACKUP_FAILED', 'O snapshot SQLite não foi concluído. Confira a origem, as permissões e o espaço em disco.');
  } finally {
    sourceDb?.close();
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const source = process.env.DATABASE_PATH || '.data/rooms.sqlite';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = process.argv[2] || join('.data', 'backups', `bot-${stamp}-${randomUUID().slice(0, 8)}.sqlite`);
  const result = await backupDatabase(source, destination);
  console.log(`Backup SQLite validado: ${result.destination}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(error => {
    console.error(error instanceof BackupError ? `${error.code}: ${error.message}` : 'BACKUP_FAILED: Falha ao preparar o backup.');
    process.exitCode = 1;
  });
}
