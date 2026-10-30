import { config } from './config.js';
import { ctx } from './ctx.js';
import { openStore, SQLITE_FILE } from './store/index.js';
import { bootNode } from './node.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';
import { scheduleBackups } from './backups.js';
import { announceAddress } from './routes/node.js';
import { startOutbox } from './messages.js';
import { startFileSweeper } from './files.js';

async function main() {
  ctx.store = await openStore(config);
  const say = (m: string) => console.log(`[little-dipper] ${m}`);
  say(`Store: ${{ sqlite: `SQLite (${config.dataDir}/${SQLITE_FILE})`, mongo: 'MongoDB', file: `local file (${config.dataDir}/store.json)` }[ctx.store.kind]}`);
  const { moved } = await bootNode(say);
  await runMigrations(say);

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  say(`Answering at ${config.hostUrl}`);
  scheduleBackups(say);
  startOutbox();
  startFileSweeper();

  if (moved) {
    // The host address changed between boots: tell every connection.
    announceAddress(say).then((r) => r.notified.length && say(`Address change sent to ${r.notified.join(', ')}`)).catch(() => {});
  }

  const stop = async () => {
    await app.close();
    await ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
