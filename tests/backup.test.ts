import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, BackupError } from '../src/backup.js';

function setup(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ff-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('backup preserva transações WAL e pode ser restaurado sem interromper a origem', async t => {
  const dir = setup(t); const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source); t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE results(id INTEGER PRIMARY KEY, winner TEXT NOT NULL); INSERT INTO results VALUES(1,\'team-1\');');
  assert.ok(existsSync(`${source}-wal`));
  const destination = join(dir, 'backups', 'snapshot.sqlite');
  const result = await backupDatabase(source, destination);
  assert.ok(result.pages > 0); assert.equal(result.destination, destination);
  const restored = new DatabaseSync(destination);
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT winner FROM results WHERE id=1').get()?.winner, 'team-1');
    restored.exec("INSERT INTO results VALUES(2,'restored-only')");
    assert.equal(db.prepare('SELECT count(*) AS count FROM results').get()?.count, 1);
  } finally { restored.close(); }
  db.exec("INSERT INTO results VALUES(3,'source-still-open')");
  assert.equal(db.prepare('SELECT count(*) AS count FROM results').get()?.count, 2);
  if (process.platform !== 'win32') {
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'backups')).mode & 0o777, 0o700);
  }
});

test('destino existente é preservado e origem inexistente não cria banco vazio', async t => {
  const dir = setup(t); const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source); db.exec('CREATE TABLE data(id INTEGER)'); db.close();
  const destination = join(dir, 'previous.sqlite'); writeFileSync(destination, 'previous backup');
  await assert.rejects(backupDatabase(source, destination), (e: unknown) => e instanceof BackupError && e.code === 'DESTINATION_EXISTS');
  assert.equal(readFileSync(destination, 'utf8'), 'previous backup');
  const missing = join(dir, 'missing.sqlite');
  await assert.rejects(backupDatabase(missing, join(dir, 'empty.sqlite')), (e: unknown) => e instanceof BackupError && e.code === 'SOURCE_MISSING');
  assert.equal(existsSync(missing), false); assert.equal(existsSync(join(dir, 'empty.sqlite')), false);
});

test('origem inválida não publica destino e remove artefatos temporários', async t => {
  const dir = setup(t); const source = join(dir, 'corrupt.sqlite'); const destination = join(dir, 'snapshot.sqlite');
  writeFileSync(source, 'not a sqlite database');
  await assert.rejects(backupDatabase(source, destination), (e: unknown) => e instanceof BackupError && e.code === 'BACKUP_FAILED');
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(dir), ['corrupt.sqlite']);
});

test('destinos concorrentes não sobrescrevem um backup publicado', async t => {
  const dir = setup(t); const source = join(dir, 'source.sqlite'); const destination = join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(source); db.exec('CREATE TABLE data(id INTEGER); INSERT INTO data VALUES(1);'); db.close();
  const results = await Promise.allSettled([backupDatabase(source, destination), backupDatabase(source, destination)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const restored = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(restored.prepare('SELECT id FROM data').get()?.id, 1); } finally { restored.close(); }
  assert.ok(!readdirSync(dir).some(name => name.startsWith('.backup-')));
});

test('não permite escrever no próprio banco nem seguir origem simbólica', async t => {
  const dir = setup(t); const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source); db.exec('CREATE TABLE data(id INTEGER)'); db.close();
  await assert.rejects(backupDatabase(source, source), (e: unknown) => e instanceof BackupError && e.code === 'SAME_FILE');
  const link = join(dir, 'link.sqlite'); symlinkSync(source, link);
  await assert.rejects(backupDatabase(link, join(dir, 'snapshot.sqlite')), (e: unknown) => e instanceof BackupError && e.code === 'SOURCE_INVALID');
});
