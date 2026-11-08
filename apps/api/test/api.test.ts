import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../src/index.js';

const WORKER = fileURLToPath(new URL('../../../packages/engine/dist/worker.js', import.meta.url));
const SCRIPT = 'local total = 0\nfor i = 1, 4 do total = total + i end\nprint("total", total)';

let app: App;
let base: string;

before(async () => {
  app = createApp({
    dataFile: null,
    workerPath: WORKER,
    adminEmail: 'admin@synex.test',
    adminPassword: 'admin-password-1',
    timeoutMs: 30_000,
    rateLimitPerMinute: 10_000,
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
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

async function login(email: string, password: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200);
  return r.json.token;
}

async function waitJob(id: string, token: string) {
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/jobs/${id}`, undefined, token);
    if (['done', 'failed', 'timeout'].includes(r.json.job.status)) return r.json.job;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('el trabajo no terminó a tiempo');
}

test('registro valida credenciales y evita duplicados', async () => {
  assert.equal((await call('POST', '/api/auth/register', { email: 'no-es-correo', password: 'longenough' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', password: 'corta' })).status, 400);
  const ok = await call('POST', '/api/auth/register', { email: 'ana@synex.test', password: 'clave-segura-1' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.role, 'user');
  assert.equal((await call('POST', '/api/auth/register', { email: 'ANA@synex.test', password: 'clave-segura-1' })).status, 409);
});

test('login con contraseña incorrecta devuelve 401 y tras 5 fallos bloquea', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/auth/login', { email: 'ana@synex.test', password: 'mal-mal-mal' })).status, 401);
  }
  assert.equal((await call('POST', '/api/auth/login', { email: 'ana@synex.test', password: 'clave-segura-1' })).status, 429);
});

test('rutas protegidas exigen token', async () => {
  assert.equal((await call('GET', '/api/jobs')).status, 401);
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' })).status, 401);
});

test('flujo completo: enviar, esperar, descargar y consultar historial', async () => {
  await call('POST', '/api/auth/register', { email: 'flujo@synex.test', password: 'clave-segura-2' });
  const token = await login('flujo@synex.test', 'clave-segura-2');
  const sent = await call('POST', '/api/jobs', { name: 'mi_script.lua', source: SCRIPT, profile: 'medium', seed: 3, checkEquivalence: true }, token);
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
  assert.equal(list.json.jobs[0].profile, 'medium');

  const stats = await call('GET', '/api/stats', undefined, token);
  assert.equal(stats.json.totalJobs, 1);
  assert.equal(stats.json.byStatus.done, 1);
  assert.equal(stats.json.perProfile.medium, 1);
});

test('un usuario no puede ver los trabajos de otro', async () => {
  await call('POST', '/api/auth/register', { email: 'otro@synex.test', password: 'clave-segura-3' });
  const ownerToken = await login('flujo@synex.test', 'clave-segura-2');
  const sent = await call('POST', '/api/jobs', { source: SCRIPT, profile: 'basic' }, ownerToken);
  const otherToken = await login('otro@synex.test', 'clave-segura-3');
  assert.equal((await call('GET', `/api/jobs/${sent.json.id}`, undefined, otherToken)).status, 404);
  assert.equal((await call('GET', `/api/jobs/${sent.json.id}/code`, undefined, otherToken)).status, 404);
});

test('validación de envíos: perfil inválido, sin script y script con error', async () => {
  const token = await login('flujo@synex.test', 'clave-segura-2');
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'ultra' }, token)).status, 400);
  assert.equal((await call('POST', '/api/jobs', { profile: 'basic' }, token)).status, 400);
  const bad = await call('POST', '/api/jobs', { source: 'break', profile: 'basic' }, token);
  assert.equal(bad.status, 202);
  const job = await waitJob(bad.json.id, token);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'E_BREAK_OUTSIDE_LOOP');
  assert.equal((await call('GET', `/api/jobs/${bad.json.id}/code`, undefined, token)).status, 409);
});

test('JSON no válido y cuerpo demasiado grande', async () => {
  const token = await login('flujo@synex.test', 'clave-segura-2');
  const res = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{no es json',
  });
  assert.equal(res.status, 400);
  // El servidor corta la conexión al superar el límite; según el momento, el cliente
  // puede ver el 413 o un corte de red. Ambos son aceptables; lo que no debe pasar es un 200.
  const huge = 'x'.repeat(3 * 1024 * 1024);
  try {
    const r2 = await fetch(base + '/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ source: huge, profile: 'basic' }),
    });
    assert.equal(r2.status, 413);
  } catch (e) {
    assert.match(String((e as Error).cause ?? e), /reset|closed|socket|terminated|fetch failed|ECONN/i);
  }
});

test('admin: solo administradores acceden; puede cambiar la configuración', async () => {
  const userToken = await login('flujo@synex.test', 'clave-segura-2');
  assert.equal((await call('GET', '/api/admin/users', undefined, userToken)).status, 403);
  const adminToken = await login('admin@synex.test', 'admin-password-1');
  const users = await call('GET', '/api/admin/users', undefined, adminToken);
  assert.equal(users.status, 200);
  assert.ok(users.json.users.some((u: any) => u.email === 'flujo@synex.test'));
  assert.equal((await call('PUT', '/api/admin/settings', { maxInputBytes: 100 }, adminToken)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { enabledProfiles: ['basic'] }, adminToken)).status, 200);
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'max' }, userToken)).status, 403);
  await call('PUT', '/api/admin/settings', { enabledProfiles: ['basic', 'medium', 'max'] }, adminToken);
});

test('solo expone Basic, Medium y Max y mantiene salud pública', async () => {
  const p = await call('GET', '/api/profiles');
  assert.equal(p.status, 200);
  assert.equal(p.json.profiles.length, 3);
  assert.equal((await call('GET', '/api/auth/discord')).status, 503);
  assert.equal((await call('POST', '/api/discord/interactions', { type: 1 })).status, 503);
  assert.deepEqual(p.json.profiles.map((x: any) => x.name), ['basic', 'medium', 'max']);
  assert.equal((await call('POST', '/api/jobs', { source: SCRIPT, profile: 'advanced' }, await login('flujo@synex.test', 'clave-segura-2'))).status, 400);
  assert.ok(p.json.techniques.some((t: any) => t.id === 'vm' && t.status === 'implemented'));
  assert.ok(p.json.techniques.some((t: any) => t.id === 'integrity' && t.status === 'implemented'));
  assert.equal(p.json.techniques.filter((t: any) => t.status !== 'implemented').length, 0);
  const h = await call('GET', '/api/health');
  assert.equal(h.json.status, 'ok');
});

test('rutas desconocidas y métodos no permitidos', async () => {
  assert.equal((await call('GET', '/api/nada')).status, 404);
  assert.equal((await call('DELETE', '/api/health')).status, 405);
});

test('errores internos se registran y el admin puede verlos', async () => {
  app.store.logError({ at: Date.now(), method: 'GET', path: '/x', message: 'prueba' });
  const adminToken = await login('admin@synex.test', 'admin-password-1');
  const r = await call('GET', '/api/admin/errors', undefined, adminToken);
  assert.ok(r.json.errors.some((e: any) => e.message === 'prueba'));
});
