import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobManager, PROFILES, TECHNIQUES, type JobRecord, type ProfileName, type TechniqueSettings } from '@synex/engine';
import { hashPassword, LoginLimiter, Sessions, validateCredentials, verifyPassword, type User } from './auth.js';
import { Store, type HistoryEntry } from './store.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Sirve un archivo de webDir sin salir de la carpeta; las rutas desconocidas reciben index.html. */
async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const base = normalize(root);
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(base, decoded === '/' ? 'index.html' : decoded));
  const inside = candidate === base || candidate.startsWith(base + sep);
  const target = inside ? candidate : join(base, 'index.html');
  const fallback = async (): Promise<void> => {
    const html = await readFile(join(base, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(html);
  };
  try {
    const info = await stat(target);
    if (!info.isFile()) return fallback();
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    await fallback().catch(() => {
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      res.end('<!doctype html><p>La aplicación web no está compilada (npm run build -w @synex/web).</p>');
    });
  }
}

export interface AppOptions {
  /** Archivo JSON de persistencia; null para solo memoria. */
  dataFile?: string | null;
  /** Ruta del worker compilado del motor (dist/worker.js de @synex/engine). */
  workerPath: string;
  /** Carpeta con la aplicación web compilada (apps/web/dist). Si se omite, no se sirven archivos estáticos. */
  webDir?: string;
  /** Crea un administrador al arrancar si aún no existe. */
  adminEmail?: string;
  adminPassword?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Peticiones por minuto y por IP. */
  rateLimitPerMinute?: number;
}

export interface App {
  server: Server;
  store: Store;
  jobs: JobManager;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'E_HTTP') {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  user: User | null;
  url: URL;
}

type Handler = (ctx: Ctx) => Promise<void> | void;
interface Route { method: string; pattern: RegExp; keys: string[]; auth: 'none' | 'user' | 'admin'; handler: Handler }

const VALID_PROFILES = ['normal', 'medium', 'max', 'basic', 'advanced', 'professional', 'roblox', 'custom'] as const;

export function createApp(opts: AppOptions): App {
  const store = new Store(opts.dataFile ?? null);
  const sessions = new Sessions();
  const limiter = new LoginLimiter();
  const jobs = new JobManager({
    workerPath: opts.workerPath,
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxQueue: 200,
  });
  const codes = new Map<string, string>();
  const ipWindow = new Map<string, { count: number; reset: number }>();
  const rateLimit = opts.rateLimitPerMinute ?? 300;

  if (opts.adminEmail && opts.adminPassword && !store.users.some((u) => u.email === opts.adminEmail)) {
    store.addUser({
      id: randomUUID(),
      email: opts.adminEmail,
      role: 'admin',
      passwordHash: hashPassword(opts.adminPassword),
      createdAt: Date.now(),
    });
  }

  const publicUser = (u: User) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  };

  const readJson = (req: IncomingMessage, limit: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, 'cuerpo demasiado grande', 'E_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'JSON no válido', 'E_BAD_JSON'));
        }
      });
      req.on('error', reject);
    });

  const bodyObject = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'se esperaba un objeto JSON');
    return raw as Record<string, unknown>;
  };

  const authUser = (req: IncomingMessage): User | null => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    const id = sessions.userIdFor(h.slice(7));
    return id ? store.users.find((u) => u.id === id) ?? null : null;
  };

  const routes: Route[] = [];
  const route = (method: string, path: string, auth: Route['auth'], handler: Handler) => {
    const keys: string[] = [];
    const src = path.replace(/:([a-zA-Z]+)/g, (_m, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp('^' + src + '$'), keys, auth, handler });
  };

  // ------------------------------------------------------------- públicas
  route('GET', '/api/health', 'none', ({ res }) => {
    json(res, 200, {
      status: 'ok',
      engine: { queued: jobs.queueLength, running: jobs.runningCount, concurrency: opts.concurrency ?? 2 },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  route('GET', '/api/profiles', 'none', ({ res }) => {
    json(res, 200, {
      profiles: VALID_PROFILES.map((name) => ({
        name,
        techniques: name === 'custom' ? [] : PROFILES[name].techniques,
        settings: name === 'custom' ? null : PROFILES[name],
      })),
      techniques: Object.entries(TECHNIQUES).map(([id, t]) => ({ id, label: t.label, status: t.status })),
    });
  });

  route('POST', '/api/auth/register', 'none', async ({ req, res }) => {
    const body = bodyObject(await readJson(req, 4096));
    const err = validateCredentials(body.email, body.password);
    if (err) throw new HttpError(400, err, 'E_VALIDATION');
    const email = String(body.email).toLowerCase();
    if (store.users.some((u) => u.email === email)) throw new HttpError(409, 'el correo ya está registrado', 'E_EXISTS');
    const user: User = {
      id: randomUUID(),
      email,
      role: 'user',
      passwordHash: hashPassword(String(body.password)),
      createdAt: Date.now(),
    };
    store.addUser(user);
    json(res, 201, { user: publicUser(user) });
  });

  route('POST', '/api/auth/login', 'none', async ({ req, res }) => {
    const body = bodyObject(await readJson(req, 4096));
    const email = String(body.email ?? '').toLowerCase();
    if (limiter.blocked(email)) throw new HttpError(429, 'demasiados intentos, espera 15 minutos', 'E_LOCKED');
    const user = store.users.find((u) => u.email === email);
    if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.passwordHash)) {
      limiter.fail(email);
      throw new HttpError(401, 'credenciales no válidas', 'E_AUTH');
    }
    limiter.reset(email);
    json(res, 200, { token: sessions.create(user.id), user: publicUser(user) });
  });

  // ------------------------------------------------------------ usuario
  route('POST', '/api/auth/logout', 'user', ({ req, res }) => {
    const h = req.headers.authorization ?? '';
    sessions.revoke(h.slice(7));
    json(res, 200, { ok: true });
  });

  route('GET', '/api/me', 'user', ({ res, user }) => {
    const jobCount = store.history.filter((h) => h.userId === user!.id).length;
    json(res, 200, { user: publicUser(user!), jobCount });
  });

  route('POST', '/api/jobs', 'user', async ({ req, res, user }) => {
    const settings = store.settings;
    const body = bodyObject(await readJson(req, settings.maxInputBytes * 2 + 4096));
    if (typeof body.source !== 'string' || body.source.trim() === '') throw new HttpError(400, 'falta el script', 'E_VALIDATION');
    const profile = String(body.profile ?? 'basic') as ProfileName;
    if (!VALID_PROFILES.includes(profile)) throw new HttpError(400, 'perfil no válido', 'E_VALIDATION');
    if (!settings.enabledProfiles.includes(profile)) throw new HttpError(403, 'perfil deshabilitado por el administrador', 'E_DISABLED');
    const seed = Number.isInteger(body.seed) ? (body.seed as number) : 1;
    const custom = body.custom && typeof body.custom === 'object' ? (body.custom as Partial<TechniqueSettings>) : undefined;
    const fileName = typeof body.name === 'string' && body.name.length <= 120 ? body.name : 'script.lua';

    let rec: JobRecord;
    try {
      rec = jobs.submit(body.source, { profile, seed, custom, checkEquivalence: body.checkEquivalence === true, maxInputBytes: settings.maxInputBytes });
    } catch (e) {
      throw new HttpError(503, (e as Error).message, 'E_BUSY');
    }
    const entry: HistoryEntry = {
      id: rec.id,
      userId: user!.id,
      fileName,
      profile,
      status: 'queued',
      createdAt: rec.createdAt,
    };
    store.addHistory(entry);
    void jobs.waitFor(rec.id).then((done) => {
      const patch: Partial<HistoryEntry> = {
        status: done.status,
        finishedAt: done.finishedAt,
        durationMs: done.startedAt && done.finishedAt ? done.finishedAt - done.startedAt : undefined,
      };
      if (done.result) {
        codes.set(rec.id, done.result.code);
        patch.digest = done.result.digest;
        patch.outputBytes = done.result.stats.outputBytes;
        patch.equivalence = done.result.equivalence.status;
      }
      if (done.error) patch.error = done.error;
      store.updateHistory(rec.id, patch);
    });
    json(res, 202, { id: rec.id, status: rec.status, profile });
  });

  route('GET', '/api/jobs', 'user', ({ res, user }) => {
    const mine = store.history.filter((h) => h.userId === user!.id).sort((a, b) => b.createdAt - a.createdAt);
    json(res, 200, { jobs: mine });
  });

  const ownedJob = (id: string, user: User): HistoryEntry => {
    const h = store.history.find((x) => x.id === id && x.userId === user.id);
    if (!h) throw new HttpError(404, 'trabajo no encontrado', 'E_NOT_FOUND');
    return h;
  };

  route('GET', '/api/jobs/:id', 'user', ({ res, user, params }) => {
    const h = ownedJob(params.id, user!);
    json(res, 200, { job: { ...h, live: jobs.get(h.id)?.status ?? h.status, hasCode: codes.has(h.id) } });
  });

  route('GET', '/api/jobs/:id/code', 'user', ({ res, user, params }) => {
    const h = ownedJob(params.id, user!);
    const code = codes.get(h.id);
    if (code === undefined) throw new HttpError(409, 'el trabajo no tiene resultado disponible', 'E_NO_RESULT');
    const name = h.fileName.replace(/\.lua$/i, '') + '.obf.lua';
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(code);
  });

  route('GET', '/api/stats', 'user', ({ res, user }) => {
    const mine = store.history.filter((h) => h.userId === user!.id);
    const byStatus: Record<string, number> = {};
    const perProfile: Record<string, number> = {};
    for (const h of mine) {
      byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
      perProfile[h.profile] = (perProfile[h.profile] ?? 0) + 1;
    }
    const durations = mine.filter((h) => h.status === 'done' && h.durationMs !== undefined).map((h) => h.durationMs!);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const recentErrors = mine
      .filter((h) => h.error)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((h) => ({ id: h.id, fileName: h.fileName, message: h.error!.message }));
    json(res, 200, {
      totalJobs: mine.length,
      byStatus,
      perProfile,
      averageProcessingMs: avg,
      latest: mine.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
      recentErrors,
    });
  });

  // ---------------------------------------------------------- admin
  route('GET', '/api/admin/users', 'admin', ({ res }) => {
    json(res, 200, {
      users: store.users.map((u) => ({
        ...publicUser(u),
        jobCount: store.history.filter((h) => h.userId === u.id).length,
      })),
    });
  });

  route('GET', '/api/admin/jobs', 'admin', ({ res }) => {
    json(res, 200, { jobs: [...store.history].sort((a, b) => b.createdAt - a.createdAt) });
  });

  route('GET', '/api/admin/errors', 'admin', ({ res }) => {
    json(res, 200, { errors: store.errors.slice(-100).reverse() });
  });

  route('GET', '/api/admin/settings', 'admin', ({ res }) => {
    json(res, 200, { settings: store.settings });
  });

  route('PUT', '/api/admin/settings', 'admin', async ({ req, res }) => {
    const body = bodyObject(await readJson(req, 4096));
    const patch: { maxInputBytes?: number; enabledProfiles?: string[] } = {};
    if (body.maxInputBytes !== undefined) {
      const n = body.maxInputBytes;
      if (!Number.isInteger(n) || (n as number) < 1024 || (n as number) > 10 * 1024 * 1024) {
        throw new HttpError(400, 'maxInputBytes debe estar entre 1 KB y 10 MB', 'E_VALIDATION');
      }
      patch.maxInputBytes = n as number;
    }
    if (body.enabledProfiles !== undefined) {
      if (!Array.isArray(body.enabledProfiles) || !body.enabledProfiles.every((p) => VALID_PROFILES.includes(p as ProfileName))) {
        throw new HttpError(400, 'enabledProfiles contiene perfiles no válidos', 'E_VALIDATION');
      }
      if (body.enabledProfiles.length === 0) throw new HttpError(400, 'debe quedar al menos un perfil', 'E_VALIDATION');
      patch.enabledProfiles = body.enabledProfiles as string[];
    }
    json(res, 200, { settings: store.updateSettings(patch) });
  });

  // ---------------------------------------------------------- servidor
  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const w = ipWindow.get(ip);
    if (!w || w.reset < now) ipWindow.set(ip, { count: 1, reset: now + 60_000 });
    else if (++w.count > rateLimit) return json(res, 429, { error: { code: 'E_RATE', message: 'demasiadas peticiones' } });

    if (opts.webDir && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(opts.webDir, url.pathname, res);
    }

    const matches = routes.filter((r) => r.pattern.test(url.pathname));
    if (matches.length === 0) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'ruta no encontrada' } });
    const r = matches.find((x) => x.method === req.method);
    if (!r) return json(res, 405, { error: { code: 'E_METHOD', message: 'método no permitido' } });

    const user = authUser(req);
    if (r.auth !== 'none') {
      if (!user) return json(res, 401, { error: { code: 'E_UNAUTH', message: 'se requiere inicio de sesión' } });
      if (r.auth === 'admin' && user.role !== 'admin') return json(res, 403, { error: { code: 'E_FORBIDDEN', message: 'solo administradores' } });
    }
    const m = r.pattern.exec(url.pathname)!;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await r.handler({ req, res, params, user, url });
  };

  const server = createServer((req, res) => {
    dispatch(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (!res.headersSent) json(res, e.status, { error: { code: e.code, message: e.message } });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      store.logError({ at: Date.now(), method: req.method ?? '?', path: req.url ?? '?', message });
      if (!res.headersSent) json(res, 500, { error: { code: 'E_INTERNAL', message: 'error interno' } });
    });
  });

  return {
    server,
    store,
    jobs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
