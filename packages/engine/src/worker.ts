import { parentPort, workerData } from 'node:worker_threads';
import { runProfile, type EngineOptions } from './engine.js';

/** Punto de entrada de un trabajo aislado: ejecuta el motor y devuelve el resultado o el error. */
const { source, options } = workerData as { source: string; options: EngineOptions };
try {
  const result = runProfile(source, options);
  parentPort!.postMessage({ ok: true, result });
} catch (e) {
  const err = e as { message?: string; code?: string };
  parentPort!.postMessage({ ok: false, error: { message: err.message ?? String(e), code: err.code } });
}
