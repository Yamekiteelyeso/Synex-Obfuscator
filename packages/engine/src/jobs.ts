import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { EngineOptions, EngineResult } from './engine.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout';

export interface JobRecord {
  id: string;
  status: JobStatus;
  profile: EngineOptions['profile'];
  inputBytes: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: EngineResult;
  error?: { message: string; code?: string };
}

export interface JobManagerOptions {
  /** Trabajos simultáneos (cada uno en su propio worker_thread). */
  concurrency?: number;
  /** Tiempo máximo por trabajo; al superarlo el worker se termina. */
  timeoutMs?: number;
  /** Número máximo de trabajos en cola. */
  maxQueue?: number;
  /** Ruta del worker compilado (dist/worker.js). */
  workerPath: string;
}

interface Pending {
  record: JobRecord;
  source: string;
  options: EngineOptions;
  resolve: (r: JobRecord) => void;
}

/**
 * Sistema de trabajos: cola con límite, concurrencia acotada y aislamiento real
 * (cada trabajo corre en un worker_thread que se termina si excede el tiempo).
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly maxRetainedJobs = 5_000;
  private readonly queue: Pending[] = [];
  private running = 0;
  private readonly opts: Required<Omit<JobManagerOptions, 'workerPath'>> & { workerPath: string };

  constructor(options: JobManagerOptions) {
    this.opts = {
      concurrency: options.concurrency ?? 2,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxQueue: options.maxQueue ?? 100,
      workerPath: options.workerPath,
    };
  }

  submit(source: string, options: EngineOptions): JobRecord {
    if (this.queue.length >= this.opts.maxQueue) throw new Error('la cola de trabajos está llena');
    const record: JobRecord = {
      id: randomUUID(),
      status: 'queued',
      profile: options.profile,
      inputBytes: Buffer.byteLength(source, 'utf8'),
      createdAt: Date.now(),
    };
    this.jobs.set(record.id, record);
    this.pruneFinishedJobs();
    const pending: Pending = { record, source, options, resolve: () => {} };
    this.queue.push(pending);
    this.pump();
    return record;
  }

  /** Libera el código generado una vez que la capa API lo ha almacenado. */
  discardResult(id: string): void {
    const record = this.jobs.get(id);
    if (record) record.result = undefined;
  }

  /** Conserva metadatos recientes, sin retener indefinidamente miles de resultados. */
  private pruneFinishedJobs(): void {
    if (this.jobs.size <= this.maxRetainedJobs) return;
    let excess = this.jobs.size - this.maxRetainedJobs;
    for (const [id, record] of this.jobs) {
      if (excess <= 0) break;
      if (record.status === 'done' || record.status === 'failed' || record.status === 'timeout') {
        record.result = undefined;
        this.jobs.delete(id);
        excess--;
      }
    }
  }

  /** Trabajos esperando a un worker libre. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Trabajos ejecutándose ahora. */
  get runningCount(): number {
    return this.running;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Espera a que un trabajo termine (done, failed o timeout). */
  waitFor(id: string): Promise<JobRecord> {
    const record = this.jobs.get(id);
    if (!record) return Promise.reject(new Error('trabajo desconocido'));
    return new Promise((resolve) => {
      const check = () => {
        if (record.status === 'done' || record.status === 'failed' || record.status === 'timeout') resolve(record);
        else setTimeout(check, 5);
      };
      check();
    });
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.start(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private start(job: Pending): Promise<void> {
    const { record } = job;
    record.status = 'running';
    record.startedAt = Date.now();
    return new Promise<void>((resolve) => {
      const worker = new Worker(this.opts.workerPath, {
        workerData: { source: job.source, options: job.options },
      });
      let settled = false;
      const finish = (status: JobStatus, payload: { result?: EngineResult; error?: { message: string; code?: string } }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.status = status;
        record.finishedAt = Date.now();
        if (payload.result) record.result = payload.result;
        if (payload.error) record.error = payload.error;
        void worker.terminate();
        resolve();
      };
      const timer = setTimeout(() => finish('timeout', { error: { message: 'tiempo de procesamiento superado', code: 'E_TIMEOUT' } }), this.opts.timeoutMs);
      worker.on('message', (msg: { ok: boolean; result?: EngineResult; error?: { message: string; code?: string } }) => {
        if (msg.ok && msg.result) finish('done', { result: msg.result });
        else finish('failed', { error: msg.error ?? { message: 'error desconocido' } });
      });
      worker.on('error', (e: Error) => finish('failed', { error: { message: e.message } }));
      worker.on('exit', () => finish('failed', { error: { message: 'el worker terminó inesperadamente' } }));
    });
  }
}
