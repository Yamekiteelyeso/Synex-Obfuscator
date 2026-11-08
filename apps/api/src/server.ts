import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

/** Arranque del servidor. Configuración por variables de entorno. */
const port = Number(process.env.PORT ?? 8080);
const app = createApp({
  // Usa automáticamente el volumen de Railway si está montado; permite override explícito.
  dataFile: process.env.SYNEX_DATA_FILE ?? (existsSync('/data') ? '/data/synex-data.json' : './synex-data.json'),
  workerPath: fileURLToPath(new URL('../../../packages/engine/dist/worker.js', import.meta.url)),
  // Único administrador autorizado: el ID de Discord definido por el propietario.
  adminDiscordIds: ['1518079144590573690'],
  concurrency: Number(process.env.SYNEX_CONCURRENCY ?? 2),
  timeoutMs: Number(process.env.SYNEX_TIMEOUT_MS ?? 30_000),
  webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
});

app.server.listen(port, () => {
  console.log(`Synex API escuchando en http://localhost:${port}`);
});
