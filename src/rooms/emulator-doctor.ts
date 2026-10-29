import { inspectAndroidEnvironment } from './android-inspection.js';

void inspectAndroidEnvironment().then(report => {
  console.log(JSON.stringify(report, null, 2));
  if (!report.readyForInspection) process.exitCode = 1;
}).catch(() => {
  console.error(JSON.stringify({ context: 'rooms_emulator_doctor', error: 'Não foi possível concluir o diagnóstico Android.' }));
  process.exitCode = 1;
});
