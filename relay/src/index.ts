import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RelayDb } from './db.js';
import { buildServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.RELAY_DB_PATH ?? './data/relay.sqlite';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new RelayDb(DB_PATH);
const app = buildServer(db);

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`focus-lock relay listening on ${HOST}:${PORT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
