import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@synex/parser';
import { analyze } from '@synex/semantic';
import { obfuscate, createStringEncoder, createRng, createNameGenerator } from '../src/index.js';

const SAMPLE = `
local count = 0
local function bump(step)
  count = count + step
  return count
end
local greeting = "hello world"
for i = 1, 3 do
  bump(i)
end
local obj = {}
function obj:show(prefix)
  print(prefix .. greeting, self)
end
obj:show("> ")
print(count)
`;

test('renombrado: los nombres locales originales desaparecen y los globales se conservan', () => {
  const { code, stats } = obfuscate(SAMPLE, { seed: 7, encodeStrings: false });
  assert.ok(stats.symbolsRenamed >= 5);
  assert.doesNotMatch(code, /\bcount\b/);
  assert.doesNotMatch(code, /\bbump\b/);
  assert.doesNotMatch(code, /\bgreeting\b/);
  assert.match(code, /\bprint\b/);
  assert.match(code, /:\w+\("> "\)/); // el método conserva su nombre
  assert.match(code, /\.\.\s*/); // los operadores se mantienen
});

test('renombrado: la salida es Luau válido y sin globales nuevos', () => {
  const { code } = obfuscate(SAMPLE, { seed: 3 });
  const r = analyze(parse(code));
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.globals.has('print'), true);
  assert.equal(r.globals.has('count'), false);
});

test('misma semilla produce la misma salida; otra semilla, otra salida', () => {
  const a = obfuscate(SAMPLE, { seed: 42 }).code;
  const b = obfuscate(SAMPLE, { seed: 42 }).code;
  const c = obfuscate(SAMPLE, { seed: 43 }).code;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('los nombres generados nunca colisionan con palabras clave ni globales', () => {
  const rng = createRng(5);
  const reserved = new Set(['print', 'string', 'table']);
  const gen = createNameGenerator(rng, reserved);
  const names = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const n = gen();
    assert.match(n, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.equal(names.has(n), false);
    names.add(n);
  }
});

test('el método self no se renombra y la llamada con : sigue funcionando', () => {
  const { code } = obfuscate('local t = {}\nfunction t:go(x) return self, x end', { seed: 9, encodeStrings: false });
  assert.match(code, /function \w+:\w+\(/);
  assert.match(code, /return self,/);
  assert.equal(analyze(parse(code)).diagnostics.length, 0);
});

test('cadenas: el texto plano ya no aparece en la salida', () => {
  const { code, stats } = obfuscate(SAMPLE, { seed: 11, renameIdentifiers: false });
  assert.ok(stats.stringsEncoded >= 2);
  assert.doesNotMatch(code, /"hello world"/);
  assert.doesNotMatch(code, /"> "/);
});

test('cadenas de índice con punto no se cifran (son identificadores)', () => {
  const { code } = obfuscate('local t = {}\nt.name = t.name', { seed: 2, renameIdentifiers: false });
  assert.match(code, /t\.name/);
});

test('cadenas: el codificador devuelve el valor original', () => {
  const names = { table: 'E', keys: 'K', cache: 'C', decode: 'D' };
  const enc = createStringEncoder(names, createRng(99));
  const values = ['', 'a', 'hello world', 'ñandú', '\x00\xff\x80'];
  const refs = values.map((v) => enc.encode(v));
  refs.forEach((ref, i) => {
    const idx = Number(/\((\d+)\)/.exec(ref)![1]);
    assert.equal(enc.decodeReference(idx), values[i]);
  });
});

test('cadenas repetidas comparten entrada en la tabla', () => {
  const { stats, code } = obfuscate('print("x", "x", "x")', { seed: 1, renameIdentifiers: false });
  assert.equal(stats.stringsEncoded, 1);
  assert.match(code, /\(1\)/);
});

test('la cabecera de cadenas se incluye solo si hay cadenas', () => {
  const { code } = obfuscate('local x = 1', { seed: 1 });
  assert.doesNotMatch(code, /bit32/);
});

test('un programa con errores semánticos no se ofusca', () => {
  assert.throws(() => obfuscate('break'), (e: any) => e.code === 'E_BREAK_OUTSIDE_LOOP');
});

test('programa grande: se procesa completo y sigue siendo válido', () => {
  const parts: string[] = [];
  for (let i = 0; i < 400; i++) {
    parts.push(`local v${i} = ${i} + ${i % 7}\nif v${i} > 3 then print("item ${i}", v${i}) end`);
  }
  const big = parts.join('\n');
  const { code, stats } = obfuscate(big, { seed: 5 });
  assert.ok(stats.symbolsRenamed >= 400);
  assert.equal(analyze(parse(code)).diagnostics.length, 0);
});

test('rendimiento: un script de ~4000 líneas se ofusca en menos de 5 s', () => {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) lines.push(`local a${i} = "s${i}" .. tostring(${i})`);
  const t0 = Date.now();
  obfuscate(lines.join('\n'), { seed: 8 });
  assert.ok(Date.now() - t0 < 5000);
});
