import { reportError } from '../config.js';
import { loadRoomsConfig } from './config.js';
import { verifyRoomsConnections } from './verification.js';

async function main(): Promise<void> {
  const report = await verifyRoomsConnections(loadRoomsConfig());
  console.log(JSON.stringify(report, null, 2));
  if (!report.connectionsVerified) process.exitCode = 1;
}
void main().catch(error => { reportError(error, 'rooms_verify'); process.exitCode = 1; });
