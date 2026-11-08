import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/index.js';
import { Store } from '../src/store.js';

const WORKER = fileURLToPath(new URL('../../../packages/engine/dist/worker.js', import.meta.url));
const SCRIPT = 'local total = 0\nfor i = 1, 4 do total = total + i end\nprint("total", total)';
const CLIENT_ID = '123456789012345678';
const ADMIN_DISCORD_ID = 'admin-discord-user';
const originalFetch = globalThis.fetch;
const oauthUsers = new Map<string, { id: string; username: string; global_name: string }>();
const oauthAccess = new Map<string, { id: string; username: string; global_name: string }>();

let app: App;
let base: string;
let oauthCodeNumber = 0;

before(async () => {
  process.env.DISCORD_CLIENT_ID = CLIENT_ID;
  process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
  process.env.DISCORD_REDIRECT_URI = 'https://synex.test/api/auth/discord/callback';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const code = form.get('code') ?? '';
      const user = oauthUsers.get(code);
      if (!user) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      const accessToken = `test-access-${code}`;
      oauthAccess.set(accessToken, user);
      return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 604800, scope: 'identify' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      const accessToken = authorization.replace(/^Bearer\s+/i, '');
      const user = oauthAccess.get(accessToken);
      if (!user) return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
      return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  app = createApp({
    dataFile: null,
    workerPath: WORKER,
    adminDiscordIds: [ADMIN_DISCORD_ID],
    timeoutMs: 30_000,
    rateLimitPerMinute: 10_000,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  globalThis.fetch = originalFetch;
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;
  delete process.env.DISCORD_REDIRECT_URI;
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* texto plano */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function loginDiscord(discordId: string, username = discordId): Promise<string> {
  const code = `oauth-code-${++oauthCodeNumber}`;
  oauthUsers.set(code, { id: discordId, username, global_name: username });

  const start = await fetch(base + '/api/auth/discord', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorizationUrl = new URL(start.headers.get('location') ?? '');
  assert.equal(authorizationUrl.origin, 'https://discord.com');
  assert.equal(authorizationUrl.pathname, '/oauth2/authorize');
  assert.equal(authorizationUrl.searchParams.get('scope'), 'identify');
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'https://synex.test/api/auth/discord/callback');
  assert.equal(authorizationUrl.searchParams.has('bot'), false);
  const state = authorizationUrl.searchParams.get('state');
  assert.ok(state, 'se genera state para proteger el callback OAuth2');
  const stateCookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(stateCookie, /^synex_oauth_state=/);

  const callbackUrl = new URL('/api/auth/discord/callback', base);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state!);
  const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(callback.status, 302);
  const returnUrl = new URL(callback.headers.get('location') ?? '');
  const ticket = returnUrl.searchParams.get('discord_ticket');
  assert.ok(ticket, 'el callback devuelve un ticket opaco de un solo uso');

  const exchange = await call('POST', '/api/auth/discord/exchange', { ticket });
  assert.equal(exchange.status, 200);
  return exchange.json.token as string;
}
async function waitJob(id: string, token: string) {
  for (let i = 0; i < 400; i++) {
    const result = await call('GET', `/api/jobs/${id}`, undefined, token);
    if (['done', 'failed', 'timeout'].includes(result.json.job.status)) return result.json.job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('el trabajo no terminó a tiempo');
}

test('el acceso y las cuentas son exclusivamente de Discord', async () => {
  const token = await loginDiscord('discord-first-user', 'primer-usuario');
  const me = await call('GET', '/api/me', undefined, token);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.discordId, 'discord-first-user');
  assert.equal(me.json.user.discordUsername, 'primer-usuario');
  assert.equal(me.json.user.plan, 'free');
  assert.equal(me.json.user.obfuscationsUsed, 0);
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', password: 'clave-segura-1' })).status, 410);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'clave-segura-1' })).status, 410);
  assert.equal((await call('GET', '/api/jobs')).status, 401);
});

test('Free permite dos ofuscaciones totales y luego bloquea en el servidor', async () => {
  const token = await loginDiscord('discord-free-limit', 'free-user');
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'medium' }, token)).json.error.code, 'E_PLAN_PROFILE');
  const first = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' }, token);
  const second = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' }, token);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.json.remaining, 0);
  const third = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' }, token);
  assert.equal(third.status, 403);
  assert.equal(third.json.error.code, 'E_PLAN_LIMIT');
  const me = await call('GET', '/api/me', undefined, token);
  assert.equal(me.json.user.obfuscationsUsed, 2);
});

test('flujo completo Discord: enviar, esperar, descargar e historial', async () => {
  const token = await loginDiscord('discord-flow', 'flow-user');
  const sent = await call('POST', '/api/jobs', { name: 'mi_script.lua', source: SCRIPT, profile: 'basic', seed: 3, checkEquivalence: true }, token);
  assert.equal(sent.status, 202);
  const job = await waitJob(sent.json.id, token);
  assert.equal(job.status, 'done');
  assert.equal(job.equivalence, 'equivalent');
  assert.match(job.digest, /^[0-9a-f]{64}$/);

  const code = await call('GET', `/api/jobs/${sent.json.id}/code`, undefined, token);
  assert.equal(code.status, 200);
  assert.match(code.headers.get('content-disposition') ?? '', /mi_script\.obf\.lua/);
  assert.doesNotMatch(code.text, /"total"/);

  const list = await call('GET', '/api/jobs', undefined, token);
  assert.equal(list.json.jobs.length, 1);
  assert.equal(list.json.jobs[0].profile, 'basic');
  const stats = await call('GET', '/api/stats', undefined, token);
  assert.equal(stats.json.totalJobs, 1);
  assert.equal(stats.json.byStatus.done, 1);
});

test('un usuario no puede ver los trabajos de otra cuenta Discord', async () => {
  const ownerToken = await loginDiscord('discord-owner', 'owner');
  const sent = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' }, ownerToken);
  const otherToken = await loginDiscord('discord-other', 'other');
  assert.equal((await call('GET', `/api/jobs/${sent.json.id}`, undefined, otherToken)).status, 404);
  assert.equal((await call('GET', `/api/jobs/${sent.json.id}/code`, undefined, otherToken)).status, 404);
});

test('validación de envíos: perfil inválido, sin script y script con error', async () => {
  const token = await loginDiscord('discord-validation', 'validation');
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'ultra' }, token)).status, 400);
  assert.equal((await call('POST', '/api/jobs', { profile: 'basic' }, token)).status, 400);
  const bad = await call('POST', '/api/jobs', { source: 'break', profile: 'basic' }, token);
  assert.equal(bad.status, 202);
  const job = await waitJob(bad.json.id, token);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'E_BREAK_OUTSIDE_LOOP');
  assert.equal((await call('GET', `/api/jobs/${bad.json.id}/code`, undefined, token)).status, 409);
});

test('planes y solicitudes: el admin puede aprobar Premium y cambiar el entitlement', async () => {
  const userToken = await loginDiscord('discord-plan-user', 'plan-user');
  const plans = await call('GET', '/api/plans');
  assert.deepEqual(plans.json.plans.map((plan: any) => plan.id), ['free', 'premium', 'plus']);
  const request = await call('POST', '/api/plan-requests', { plan: 'premium' }, userToken);
  assert.equal(request.status, 201);
  assert.equal(request.json.request.status, 'pending');
  const ownRequests = await call('GET', '/api/plan-requests', undefined, userToken);
  assert.equal(ownRequests.json.requests.length, 1);

  const adminToken = await loginDiscord(ADMIN_DISCORD_ID, 'synex-admin');
  const adminRequests = await call('GET', '/api/admin/plan-requests', undefined, adminToken);
  assert.ok(adminRequests.json.requests.some((item: any) => item.id === request.json.request.id));
  const approved = await call('PUT', `/api/admin/plan-requests/${request.json.request.id}`, { status: 'approved' }, adminToken);
  assert.equal(approved.status, 200);

  const me = await call('GET', '/api/me', undefined, userToken);
  assert.equal(me.json.user.plan, 'premium');
  assert.equal(me.json.user.obfuscationLimit, null);
  const unauthenticatedMedium = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'medium' });
  assert.equal(unauthenticatedMedium.status, 401);
  const medium = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'medium' }, userToken);
  assert.equal(medium.status, 202);
});

test('admin: solo IDs de Discord autorizados administran', async () => {
  const userToken = await loginDiscord('discord-regular', 'regular');
  assert.equal((await call('GET', '/api/admin/users', undefined, userToken)).status, 403);
  const adminToken = await loginDiscord(ADMIN_DISCORD_ID, 'synex-admin');
  const users = await call('GET', '/api/admin/users', undefined, adminToken);
  assert.equal(users.status, 200);
  assert.ok(users.json.users.some((user: any) => user.discordId === 'discord-regular'));
  assert.equal((await call('PUT', '/api/admin/settings', { maxInputBytes: 100 }, adminToken)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { enabledProfiles: ['basic'] }, adminToken)).status, 200);
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'max' }, userToken)).status, 403);
  await call('PUT', '/api/admin/settings', { enabledProfiles: ['basic', 'medium', 'max'] }, adminToken);
});

test('errores internos se registran y solo el admin los ve', async () => {
  app.store.logError({ at: Date.now(), method: 'GET', path: '/x', message: 'prueba' });
  const adminToken = await loginDiscord(ADMIN_DISCORD_ID, 'synex-admin');
  const result = await call('GET', '/api/admin/errors', undefined, adminToken);
  assert.ok(result.json.errors.some((entry: any) => entry.message === 'prueba'));
});

test('OAuth2 valida el state y no solicita instalar un bot', async () => {
  const start = await fetch(base + '/api/auth/discord', { redirect: 'manual' });
  const authorizationUrl = new URL(start.headers.get('location') ?? '');
  assert.equal(authorizationUrl.searchParams.get('scope'), 'identify');
  assert.equal(authorizationUrl.searchParams.has('permissions'), false);
  assert.equal(authorizationUrl.searchParams.has('guild_id'), false);
  assert.equal(authorizationUrl.searchParams.has('bot'), false);

  const invalid = new URL('/api/auth/discord/callback', base);
  invalid.searchParams.set('code', 'not-used');
  invalid.searchParams.set('state', 'invalid-state');
  assert.equal((await fetch(invalid)).status, 401);
  const missingCookie = new URL('/api/auth/discord/callback', base);
  missingCookie.searchParams.set('code', 'not-used');
  missingCookie.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
  assert.equal((await fetch(missingCookie)).status, 401, 'el state también debe estar ligado a una cookie del navegador');

  const validStart = await fetch(base + '/api/auth/discord', { redirect: 'manual' });
  const validAuthorizationUrl = new URL(validStart.headers.get('location') ?? '');
  const code = `oauth-code-${++oauthCodeNumber}`;
  oauthUsers.set(code, { id: 'state-once-user', username: 'state-once-user', global_name: 'state-once-user' });
  const callbackUrl = new URL('/api/auth/discord/callback', base);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', validAuthorizationUrl.searchParams.get('state')!);
  const stateCookie = (validStart.headers.get('set-cookie') ?? '').split(';')[0];
  const accepted = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(accepted.status, 302);
  assert.equal((await fetch(callbackUrl)).status, 401, 'el state no se puede reutilizar');
  assert.equal((await call('GET', '/api/nada')).status, 404);
  assert.equal((await call('DELETE', '/api/health')).status, 405);
  assert.equal((await call('GET', '/api/health')).json.status, 'ok');
});

test('Store persiste cuentas, plan, uso y solicitudes; migra uso del historial anterior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synex-store-'));
  const file = join(dir, 'data.json');
  try {
    const first = new Store(file);
    first.addUser({
      id: 'persisted-user', email: 'discord-persisted@users.synex.invalid', role: 'user',
      passwordHash: '', discordId: 'discord-persisted', discordUsername: 'persisted',
      createdAt: 100, plan: 'free', obfuscationsUsed: 0,
    });
    first.recordObfuscation('persisted-user');
    first.createPlanRequest({
      id: 'request-persisted', userId: 'persisted-user', plan: 'premium',
      status: 'pending', createdAt: 200, updatedAt: 200,
    });
    const second = new Store(file);
    assert.equal(second.users[0].obfuscationsUsed, 1);
    assert.equal(second.users[0].discordId, 'discord-persisted');
    assert.equal(second.planRequests[0].status, 'pending');

    const legacyFile = join(dir, 'legacy.json');
    writeFileSync(legacyFile, JSON.stringify({
      users: [{ id: 'legacy-user', email: 'legacy@users.synex.invalid', role: 'user', passwordHash: '', createdAt: 1, discordId: 'legacy' }],
      history: [{ id: 'old-job-1', userId: 'legacy-user', fileName: 'a.lua', profile: 'basic', status: 'done', createdAt: 2 }],
      errors: [], settings: { maxInputBytes: 1048576, enabledProfiles: ['basic'] },
    }));
    const migrated = new Store(legacyFile);
    assert.equal(migrated.users[0].plan, 'free');
    assert.equal(migrated.users[0].obfuscationsUsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
