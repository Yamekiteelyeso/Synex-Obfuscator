import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runProfile, resolveSettings, PROFILES, unavailable, JobManager } from '../src/index.js';

const SAMPLE = `
local total = 0
local label = "items"
for i = 1, 5 do
  if i == 3 then total = total + 10 else total = total + i end
end
print(label, total, total == 25)
`;

test('los perfiles tienen configuraciones distintas y reales', () => {
  const b = JSON.stringify(PROFILES.basic);
  const a = JSON.stringify(PROFILES.advanced);
  const p = JSON.stringify(PROFILES.professional);
  assert.notEqual(b, a);
  assert.notEqual(a, p);
  assert.ok(PROFILES.professional.deadCodeDensity > PROFILES.advanced.deadCodeDensity);
});

test('basic, advanced y professional producen salidas distintas y todas equivalentes', () => {
  const outs = (['basic', 'advanced', 'professional'] as const).map((profile) =>
    runProfile(SAMPLE, { profile, seed: 4, checkEquivalence: true }));
  for (const r of outs) assert.equal(r.equivalence.status, 'equivalent');
  assert.notEqual(outs[0].code, outs[1].code);
  assert.notEqual(outs[1].code, outs[2].code);
  assert.ok(outs[2].stats.deadBlocks > 0);
});

test('basic no inserta código muerto ni transforma constantes', () => {
  const r = runProfile(SAMPLE, { profile: 'basic', seed: 4 });
  assert.equal(r.stats.deadBlocks, 0);
  assert.ok(!r.techniques.includes('numbers'));
});

test('custom: solo las técnicas elegidas se aplican', () => {
  const r = runProfile(SAMPLE, { profile: 'custom', custom: { techniques: ['strings'] }, seed: 2, checkEquivalence: true });
  assert.deepEqual(r.techniques, ['strings']);
  assert.equal(r.stats.symbolsRenamed, 0);
  assert.equal(r.stats.stringsEncoded > 0, true);
  assert.equal(r.equivalence.status, 'equivalent');
});

test('custom: la VM es una técnica disponible y no hay técnicas pendientes', () => {
  const s = resolveSettings('custom', { techniques: ['vm', 'strings', 'controlflow'] as any });
  assert.deepEqual(s.techniques, ['vm', 'strings', 'controlflow']);
  assert.deepEqual(unavailable(['vm', 'strings', 'controlflow', 'integrity']), []);
});

test('custom: la integridad activa también las cadenas, de las que depende', () => {
  const s = resolveSettings('custom', { techniques: ['integrity'] as any });
  assert.deepEqual(s.techniques, ['integrity', 'strings']);
});

test('custom sin técnicas válidas se rechaza', () => {
  assert.throws(() => resolveSettings('custom', { techniques: [] }), /al menos una técnica/);
});

test('digest SHA-256 coincide con el código entregado', () => {
  const a = runProfile(SAMPLE, { profile: 'advanced', seed: 6 });
  const b = runProfile(SAMPLE, { profile: 'advanced', seed: 6 });
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
});

test('se registran las etapas con tiempos', () => {
  const r = runProfile(SAMPLE, { profile: 'professional', seed: 1 });
  const names = r.stages.map((s) => s.name);
  assert.ok(names.includes('parse'));
  assert.ok(names.includes('generate'));
  assert.ok(r.stages.every((s) => s.ms >= 0));
});

test('entradas inválidas: vacía, demasiado grande y con errores semánticos', () => {
  assert.throws(() => runProfile('   ', { profile: 'basic' }), (e: any) => e.code === 'E_EMPTY');
  assert.throws(() => runProfile('print(1)', { profile: 'basic', maxInputBytes: 3 }), (e: any) => e.code === 'E_LIMIT');
  assert.throws(() => runProfile('break', { profile: 'basic' }), (e: any) => e.code === 'E_BREAK_OUTSIDE_LOOP');
});

test('equivalencia: una biblioteca ausente falla igual en original y ofuscado', () => {
  const r = runProfile('local x = unknownLibrary.call()', { profile: 'basic', checkEquivalence: true, equivalenceStepLimit: 1000 });
  assert.equal(r.equivalence.status, 'equivalent');
  assert.equal(r.equivalence.detail, 'mismo error de ejecución');
});

test('equivalencia: un error de ejecución idéntico se considera equivalente', () => {
  const r = runProfile('local t = nil\nprint(t.x)', { profile: 'advanced', checkEquivalence: true });
  assert.equal(r.equivalence.status, 'equivalent');
});

const WORKER = fileURLToPath(new URL('../dist/worker.js', import.meta.url));

test('JobManager ejecuta trabajos en workers aislados y devuelve el resultado', async () => {
  const jobs = new JobManager({ workerPath: WORKER, concurrency: 2, timeoutMs: 20000 });
  const rec = jobs.submit(SAMPLE, { profile: 'advanced', seed: 3 });
  const done = await jobs.waitFor(rec.id);
  assert.equal(done.status, 'done');
  assert.ok(done.result);
  assert.equal(done.result!.profile, 'advanced');
});

test('JobManager marca error de validación como failed con código', async () => {
  const jobs = new JobManager({ workerPath: WORKER, timeoutMs: 20000 });
  const rec = jobs.submit('break', { profile: 'basic' });
  const done = await jobs.waitFor(rec.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error?.code, 'E_BREAK_OUTSIDE_LOOP');
});

test('JobManager termina el worker si excede el tiempo', async () => {
  const hang = fileURLToPath(new URL('./hang-worker.mjs', import.meta.url));
  const jobs = new JobManager({ workerPath: hang, timeoutMs: 200 });
  const started = Date.now();
  const rec = jobs.submit(SAMPLE, { profile: 'basic', seed: 3 });
  const done = await jobs.waitFor(rec.id);
  assert.equal(done.status, 'timeout');
  assert.equal(done.error?.code, 'E_TIMEOUT');
  assert.ok(Date.now() - started < 5000, 'el tiempo límite debe cortar el trabajo rápidamente');
  assert.equal(jobs.runningCount, 0);
});

test('JobManager procesa varios trabajos y los lista', async () => {
  const jobs = new JobManager({ workerPath: WORKER, concurrency: 2, timeoutMs: 20000 });
  const ids = [1, 2, 3].map((seed) => jobs.submit(SAMPLE, { profile: 'basic', seed }).id);
  const results = await Promise.all(ids.map((id) => jobs.waitFor(id)));
  assert.ok(results.every((r) => r.status === 'done'));
  assert.equal(jobs.list().length, 3);
});
