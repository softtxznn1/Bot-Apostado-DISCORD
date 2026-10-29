import { checkRoomsHealth } from './health.js';

const report = checkRoomsHealth();
console.log(JSON.stringify(report));
if (!report.healthy) process.exitCode = 1;
