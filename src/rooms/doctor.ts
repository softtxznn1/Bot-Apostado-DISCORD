import { DatabaseSync } from 'node:sqlite';
import { reportError } from '../config.js';
import { loadRoomsConfig } from './config.js';

try {
  const config = loadRoomsConfig(); const db = new DatabaseSync(':memory:');
  db.prepare('SELECT 1').get(); db.close();
  console.log(JSON.stringify({ edition: 'rooms', node: process.versions.node, sqlite: 'ok',
    provider: config.provider, simulation: config.provider === 'simulated',
    discordTokenConfigured: !!config.token, clientIdConfigured: !!config.clientId, guildIdConfigured: !!config.guildId,
    roomApiConfigured: !!config.api, liveApiVerified: false, financialCredentialsRequired: false,
    readiness: 'Execute testes locais. Com credenciais, use npm run verify:connections; o aceite real está em docs/HOMOLOGACAO.md.' }, null, 2));
} catch (error) { reportError(error, 'rooms_doctor'); process.exitCode = 1; }
