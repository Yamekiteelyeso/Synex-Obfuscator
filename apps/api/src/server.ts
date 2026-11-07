import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

/** Arranque del servidor. Configuración por variables de entorno. */
const port = Number(process.env.PORT ?? 8080);
const app = createApp({
  dataFile: process.env.SYNEX_DATA_FILE ?? './synex-data.json',
  workerPath: fileURLToPath(new URL('../../../packages/engine/dist/worker.js', import.meta.url)),
  adminEmail: process.env.SYNEX_ADMIN_EMAIL,
  adminPassword: process.env.SYNEX_ADMIN_PASSWORD,
  concurrency: Number(process.env.SYNEX_CONCURRENCY ?? 2),
  timeoutMs: Number(process.env.SYNEX_TIMEOUT_MS ?? 30_000),
  webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
});

app.server.listen(port, () => {
  console.log(`Synex API escuchando en http://localhost:${port}`);
});
