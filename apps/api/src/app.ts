import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { JobManager, PROFILES, TECHNIQUES, type JobRecord, type ProfileName, type TechniqueSettings } from '@synex/engine';
import { Sessions, type AccountPlan, type User } from './auth.js';
import { Store, type HistoryEntry } from './store.js';
import { pruneBoundedMap } from './limits.js';

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
  /** IDs de Discord autorizados como administradores. */
  adminDiscordIds?: string[];
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

const VALID_PROFILES = ['basic', 'medium', 'max'] as const;

const ACCOUNT_PLANS: Record<AccountPlan, {
  name: string;
  priceLabel: string;
  limit: number | null;
  profiles: readonly string[];
  description: string;
  features: string[];
}> = {
  free: {
    name: 'Free',
    priceLabel: 'Gratis',
    limit: 2,
    profiles: ['basic'],
    description: 'Para probar Synex y proteger scripts pequeños.',
    features: ['2 ofuscaciones por cuenta de Discord', 'Perfil Basic', 'Historial de tus trabajos'],
  },
  premium: {
    name: 'Premium',
    priceLabel: 'Consultar precio',
    limit: null,
    profiles: ['basic', 'medium'],
    description: 'Para uso frecuente y transformaciones intermedias.',
    features: ['Ofuscaciones ilimitadas', 'Perfiles Basic y Medium', 'Soporte de upgrade'],
  },
  plus: {
    name: 'Plus',
    priceLabel: 'Consultar precio',
    limit: null,
    profiles: ['basic', 'medium', 'max'],
    description: 'Acceso completo a los perfiles de Synex.',
    features: ['Ofuscaciones ilimitadas', 'Basic, Medium y Max', 'VM y protección avanzada del perfil Max'],
  },
};

export function createApp(opts: AppOptions): App {
  const store = new Store(opts.dataFile ?? null);
  const sessions = new Sessions(12 * 60 * 60 * 1000, Date.now, store);
  const jobs = new JobManager({
    workerPath: opts.workerPath,
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxQueue: 200,
  });
  const codes = new Map<string, { code: string; bytes: number; expiresAt: number }>();
  const maxRetainedCodeBytes = 64 * 1024 * 1024;
  const maxRetainedCodeEntries = 100;
  const codeTtlMs = 30 * 60 * 1000;
  let retainedCodeBytes = 0;
  const pruneCodes = (): void => {
    const now = Date.now();
    for (const [id, entry] of codes) {
      if (entry.expiresAt <= now) {
        codes.delete(id);
        retainedCodeBytes -= entry.bytes;
      }
    }
  };
  const retainCode = (id: string, code: string): void => {
    pruneCodes();
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > maxRetainedCodeBytes) return;
    while (codes.size >= maxRetainedCodeEntries || retainedCodeBytes + bytes > maxRetainedCodeBytes) {
      const oldest = codes.entries().next().value as [string, { code: string; bytes: number; expiresAt: number }] | undefined;
      if (!oldest) break;
      codes.delete(oldest[0]);
      retainedCodeBytes -= oldest[1].bytes;
    }
    codes.set(id, { code, bytes, expiresAt: Date.now() + codeTtlMs });
    retainedCodeBytes += bytes;
  };
  const getRetainedCode = (id: string): string | undefined => {
    pruneCodes();
    return codes.get(id)?.code;
  };
  const discordStates = new Map<string, number>();
  const discordTickets = new Map<string, { userId: string; expiresAt: number }>();
  const ipWindow = new Map<string, { count: number; reset: number }>();
  const maxDiscordStates = 10_000;
  const maxDiscordTickets = 10_000;
  const maxIpWindows = 50_000;
  const rateLimit = opts.rateLimitPerMinute ?? 300;
  let nextIpPruneAt = 0;

  const publicUser = (u: User) => ({
    id: u.id,
    discordId: u.discordId,
    discordUsername: u.discordUsername,
    role: u.role,
    plan: u.plan,
    obfuscationsUsed: u.obfuscationsUsed,
    obfuscationLimit: ACCOUNT_PLANS[u.plan].limit,
    allowedProfiles: ACCOUNT_PLANS[u.plan].profiles,
    createdAt: u.createdAt,
  });

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
    const stored = id ? store.users.find((u) => u.id === id) : null;
    if (!stored) return null;
    // El permiso se deriva del ID permitido en el servidor, nunca de un rol antiguo persistido.
    stored.role = (opts.adminDiscordIds ?? []).includes(stored.discordId ?? '') ? 'admin' : 'user';
    return stored;
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
      profiles: VALID_PROFILES.map((name) => ({ name, techniques: PROFILES[name].techniques, settings: PROFILES[name] })),
      techniques: Object.entries(TECHNIQUES).map(([id, t]) => ({ id, label: t.label, status: t.status })),
    });
  });

  route('GET', '/api/plans', 'none', ({ res }) => {
    json(res, 200, {
      plans: (Object.entries(ACCOUNT_PLANS) as [AccountPlan, typeof ACCOUNT_PLANS[AccountPlan]][]).map(([id, plan]) => ({
        id, ...plan,
      })),
    });
  });

  // OAuth2 de usuario: scope identify, sin bot, permisos de servidor ni comandos slash.
  route('GET', '/api/auth/discord', 'none', ({ res }) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUriValue = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUriValue) {
      throw new HttpError(503, 'configura DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET y DISCORD_REDIRECT_URI', 'E_DISCORD_CONFIG');
    }

    let redirectUri: URL;
    try { redirectUri = new URL(redirectUriValue); }
    catch { throw new HttpError(503, 'DISCORD_REDIRECT_URI debe ser una URL válida', 'E_DISCORD_CONFIG'); }
    if (redirectUri.protocol !== 'https:' && redirectUri.hostname !== 'localhost') {
      throw new HttpError(503, 'DISCORD_REDIRECT_URI debe usar HTTPS', 'E_DISCORD_CONFIG');
    }

    const stateNow = Date.now();
    pruneBoundedMap(discordStates, stateNow, maxDiscordStates, (expiresAt) => expiresAt, 1);
    const state = randomBytes(32).toString('hex');
    discordStates.set(state, stateNow + 5 * 60_000);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri.toString(),
      response_type: 'code',
      scope: 'identify',
      state,
    });
    const cookieSecure = redirectUri.protocol === 'https:' ? '; Secure' : '';
    res.writeHead(302, {
      Location: `https://discord.com/oauth2/authorize?${params}`,
      'Set-Cookie': `synex_oauth_state=${state}; Path=/api/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=300${cookieSecure}`,
    });
    res.end();
  });

  route('GET', '/api/auth/discord/callback', 'none', async ({ req, url, res }) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUriValue = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUriValue) {
      throw new HttpError(503, 'configura DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET y DISCORD_REDIRECT_URI', 'E_DISCORD_CONFIG');
    }

    let redirectUri: URL;
    try { redirectUri = new URL(redirectUriValue); }
    catch { throw new HttpError(503, 'DISCORD_REDIRECT_URI debe ser una URL válida', 'E_DISCORD_CONFIG'); }

    const redirectAuthError = (reason: string): void => {
      const home = new URL('/', redirectUri);
      home.searchParams.set('discord_error', reason);
      res.writeHead(302, { Location: home.toString() });
      res.end();
    };

    const state = url.searchParams.get('state') ?? '';
    const stateCookie = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('synex_oauth_state='))
      ?.slice('synex_oauth_state='.length);
    res.setHeader('Set-Cookie', 'synex_oauth_state=; Path=/api/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=0' + (redirectUri.protocol === 'https:' ? '; Secure' : ''));
    pruneBoundedMap(discordStates, Date.now(), maxDiscordStates, (expiry) => expiry);
    const expiresAt = discordStates.get(state);
    discordStates.delete(state);
    if (!state || stateCookie !== state || !expiresAt || expiresAt < Date.now()) {
      redirectAuthError('expired');
      return;
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      redirectAuthError(oauthError === 'access_denied' ? 'cancelled' : 'failed');
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      redirectAuthError('failed');
      return;
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri.toString(),
        }),
      });
    } catch {
      redirectAuthError('failed');
      return;
    }
    if (!tokenResponse.ok) {
      redirectAuthError('failed');
      return;
    }

    let tokenData: { access_token?: string; scope?: string };
    try {
      tokenData = await tokenResponse.json() as { access_token?: string; scope?: string };
    } catch {
      redirectAuthError('failed');
      return;
    }
    if (!tokenData.access_token || !String(tokenData.scope ?? '').split(/\s+/).includes('identify')) {
      redirectAuthError('failed');
      return;
    }

    let profileResponse: Response;
    try {
      profileResponse = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
    } catch {
      redirectAuthError('failed');
      return;
    }
    if (!profileResponse.ok) {
      redirectAuthError('failed');
      return;
    }

    let discordUser: { id?: string; username?: string; global_name?: string | null };
    try {
      discordUser = await profileResponse.json() as { id?: string; username?: string; global_name?: string | null };
    } catch {
      redirectAuthError('failed');
      return;
    }
    if (!discordUser.id || !discordUser.username) {
      redirectAuthError('failed');
      return;
    }

    // El ID de Discord es la clave estable. El administrador recibe Plus automáticamente;
    // las demás cuentas conservan su plan, uso e historial.
    let user = store.users.find((u) => u.discordId === String(discordUser.id));
    if (!user) {
      user = {
        id: randomUUID(),
        email: `discord-${discordUser.id}@users.synex.invalid`,
        role: (opts.adminDiscordIds ?? []).includes(String(discordUser.id)) ? 'admin' : 'user',
        passwordHash: '',
        discordId: String(discordUser.id),
        discordUsername: String(discordUser.global_name || discordUser.username),
        createdAt: Date.now(),
        plan: (opts.adminDiscordIds ?? []).includes(String(discordUser.id)) ? 'plus' : 'free',
        obfuscationsUsed: 0,
      };
      store.addUser(user);
    } else {
      user.discordUsername = String(discordUser.global_name || discordUser.username);
      user.role = (opts.adminDiscordIds ?? []).includes(String(discordUser.id)) ? 'admin' : 'user';
      if (user.role === 'admin') user.plan = 'plus';
      store.updateUser(user);
    }

    // El ticket es opaco y de un solo uso; el token de sesión nunca va en la URL.
    const ticketNow = Date.now();
    pruneBoundedMap(discordTickets, ticketNow, maxDiscordTickets, (entry) => entry.expiresAt, 1);
    const ticket = randomUUID();
    discordTickets.set(ticket, { userId: user.id, expiresAt: ticketNow + 90_000 });
    const home = new URL('/', redirectUri);
    home.searchParams.set('discord_ticket', ticket);
    res.writeHead(302, { Location: home.toString() });
    res.end();
  });

  route('POST', '/api/auth/discord/exchange', 'none', async ({ req, res }) => {
    const body = bodyObject(await readJson(req, 4096)); const ticket = String(body.ticket ?? '');
    pruneBoundedMap(discordTickets, Date.now(), maxDiscordTickets, (entry) => entry.expiresAt);
    const entry = discordTickets.get(ticket); discordTickets.delete(ticket);
    if (!entry || entry.expiresAt < Date.now()) throw new HttpError(401, 'el enlace de Discord expiró; inténtalo de nuevo', 'E_DISCORD_TICKET');
    const user = store.users.find((u) => u.id === entry.userId);
    if (!user) throw new HttpError(401, 'cuenta de Discord no encontrada', 'E_DISCORD_USER');
    json(res, 200, { token: sessions.create(user.id), user: publicUser(user) });
  });

  route('POST', '/api/auth/register', 'none', async ({ res }) => {
    json(res, 410, { error: { code: 'E_DISCORD_ONLY', message: 'El acceso ahora es únicamente mediante Discord.' } });
  });

  route('POST', '/api/auth/login', 'none', async ({ res }) => {
    json(res, 410, { error: { code: 'E_DISCORD_ONLY', message: 'El acceso ahora es únicamente mediante Discord.' } });
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
    if (!(VALID_PROFILES as readonly string[]).includes(profile)) throw new HttpError(400, 'plan no válido; usa Basic, Medium o Max', 'E_VALIDATION');
    if (!settings.enabledProfiles.includes(profile)) throw new HttpError(403, 'perfil deshabilitado por el administrador', 'E_DISABLED');
    const accountPlan = ACCOUNT_PLANS[user!.plan];
    if (!accountPlan.profiles.includes(profile)) {
      throw new HttpError(403, `el plan ${accountPlan.name} no incluye el perfil ${profile.toUpperCase()}; consulta los planes disponibles`, 'E_PLAN_PROFILE');
    }
    if (accountPlan.limit !== null && user!.obfuscationsUsed >= accountPlan.limit) {
      throw new HttpError(403, 'has utilizado tus 2 ofuscaciones gratuitas; solicita Premium o Plus para continuar', 'E_PLAN_LIMIT');
    }
    // Semilla criptográficamente aleatoria si el cliente no fija una: cada build
    // produce una permutación distinta de opcodes sin romper reproducibilidad opt-in.
    const seed = Number.isInteger(body.seed) ? (body.seed as number) : randomInt(1, 0x7fffffff);
    const custom = body.custom && typeof body.custom === 'object' ? (body.custom as Partial<TechniqueSettings>) : undefined;
    const fileName = typeof body.name === 'string' && body.name.length <= 120 ? body.name : 'script.lua';

    let rec: JobRecord;
    try {
      rec = jobs.submit(body.source, { profile, seed, custom, checkEquivalence: body.checkEquivalence === true, maxInputBytes: settings.maxInputBytes });
    } catch (e) {
      throw new HttpError(503, (e as Error).message, 'E_BUSY');
    }
    store.recordObfuscation(user!.id);
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
        retainCode(rec.id, done.result.code);
        patch.digest = done.result.digest;
        patch.outputBytes = done.result.stats.outputBytes;
        patch.equivalence = done.result.equivalence.status;
      }
      if (done.error) patch.error = done.error;
      store.updateHistory(rec.id, patch);
      jobs.discardResult(rec.id);
    });
    json(res, 202, {
      id: rec.id, status: rec.status, profile,
      obfuscationsUsed: user!.obfuscationsUsed,
      remaining: accountPlan.limit === null ? null : Math.max(0, accountPlan.limit - user!.obfuscationsUsed),
    });
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
    json(res, 200, { job: { ...h, live: jobs.get(h.id)?.status ?? h.status, hasCode: getRetainedCode(h.id) !== undefined } });
  });

  route('GET', '/api/jobs/:id/code', 'user', ({ res, user, params }) => {
    const h = ownedJob(params.id, user!);
    const code = getRetainedCode(h.id);
    if (code === undefined) throw new HttpError(409, 'el trabajo no tiene resultado disponible', 'E_NO_RESULT');
    const name = h.fileName.replace(/\.luau?$/i, '') + '.obf.luau';
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

  route('PUT', '/api/admin/users/:id/plan', 'admin', async ({ req, res, params }) => {
    const body = bodyObject(await readJson(req, 4096));
    if (body.plan !== 'free' && body.plan !== 'premium' && body.plan !== 'plus') {
      throw new HttpError(400, 'el plan debe ser free, premium o plus', 'E_VALIDATION');
    }
    const updated = store.setUserPlan(params.id, body.plan);
    if (!updated) throw new HttpError(404, 'cuenta no encontrada', 'E_USER_NOT_FOUND');
    json(res, 200, { user: publicUser(updated) });
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
      if (!Array.isArray(body.enabledProfiles) || !body.enabledProfiles.every((p) => (VALID_PROFILES as readonly string[]).includes(p as string))) {
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
    if (now >= nextIpPruneAt) {
      pruneBoundedMap(ipWindow, now, maxIpWindows, (entry) => entry.reset);
      nextIpPruneAt = now + 60_000;
    }
    const w = ipWindow.get(ip);
    if (!w || w.reset <= now) {
      ipWindow.delete(ip);
      pruneBoundedMap(ipWindow, now, maxIpWindows, (entry) => entry.reset, 1);
      ipWindow.set(ip, { count: 1, reset: now + 60_000 });
    } else {
      const count = w.count + 1;
      ipWindow.delete(ip);
      ipWindow.set(ip, { count, reset: w.reset });
      if (count > rateLimit) return json(res, 429, { error: { code: 'E_RATE', message: 'demasiadas peticiones' } });
    }

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
