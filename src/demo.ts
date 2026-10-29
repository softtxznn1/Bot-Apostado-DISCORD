import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from './database.js';
import { BotService } from './service.js';
import { SimulatedRoomProvider } from './providers.js';
import { reportError } from './config.js';

async function demo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ff-demo-'));
  const filename = join(dir, 'bot.sqlite');
  let store = new Store(filename);
  try {
    const service = new BotService(store);
    const admin = { userId: 'moderador-demo', moderator: true, mediator: false };
    service.configure({ guildId: 'demo', categoryId: 'categoria', staffRoleId: 'staff', mediatorRoleId: 'mediador' }, admin);
    const q = service.createQueue('demo', admin, 1, 'mobile', 'Demonstração sem dinheiro e sem sala real.');
    service.joinQueue('demo', q.id, 'jogador-1');
    const m = service.joinQueue('demo', q.id, 'jogador-2').match!;
    assert.equal(m.state, 'confirming');
    for (const user of ['jogador-1', 'jogador-2']) service.confirm('demo', m.id, user);
    service.claim('demo', m.id, admin);
    const room = await service.createRoom('demo', m.id, admin, new SimulatedRoomProvider());
    assert.equal(room.room?.source, 'simulated');
    service.startMatch('demo', m.id, admin);
    service.proposeResult('demo', m.id, admin, 1, '7x3');
    service.acceptResult('demo', m.id, 'jogador-1'); service.acceptResult('demo', m.id, 'jogador-2');
    assert.equal(service.match('demo', m.id).state, 'finished');
    store.close(); store = new Store(filename);
    const recovered = new BotService(store);
    assert.equal(recovered.match('demo', m.id).state, 'finished');
    assert.equal(recovered.ranking('demo')[0]?.wins, 1);
    console.log('SIMULAÇÃO LOCAL: fila → confirmação → mediador → sala simulada → resultado → ranking.');
    console.log('SQLite reaberto: partida e ranking preservados. Nenhuma conexão ao Discord ou ao jogo.');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
void demo().catch(error => { reportError(error, 'demo'); process.exitCode = 1; });
