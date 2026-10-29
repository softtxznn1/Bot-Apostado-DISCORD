import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../../src/database.js';
import { BotService } from '../../src/service.js';
import { DomainError } from '../../src/domain.js';

const { filename, queueId, user } = workerData as { filename: string; queueId: string; user: string };
const store = new Store(filename);
let outcome: string;
try { new BotService(store).joinQueue('guild', queueId, user); outcome = 'joined'; }
catch (error) { if (!(error instanceof DomainError)) throw error; outcome = error.code; }
finally { store.close(); }
parentPort!.postMessage(outcome);
