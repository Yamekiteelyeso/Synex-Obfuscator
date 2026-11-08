import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '@synex/runtime';
import { parse, printChunk } from '@synex/parser';
import { analyze } from '@synex/semantic';
import { obfuscate, transformNumbers, transformExpressions, insertDeadCode, createRng, createNameGenerator } from '../src/index.js';

const PROGRAMS = [
  'local t = {1, 2, 3}\nlocal s = 0\nfor i = 1, #t do s = s + t[i] * 10 end\nprint(s, 7 == 7, 7 == 8)',
  'local function f(x) if x == 2 then return "two" elseif x ~= 3 then return "other" end return "three" end\nprint(f(2), f(3), f(9))',
  'local n = 0\nwhile n < 5 do n = n + 1; if n == 3 then continue end end\nprint(n)',
  'local a, b = 1000000, 0.5\nprint(a - 1, b * 2, 2 ^ 3)',
  'local n = -999999\nprint(n, 999999, -42, 0)',
];

for (const [i, src] of PROGRAMS.entries()) {
  test(`pases de números: programa ${i}`, () => {
    const chunk = parse(src);
    transformNumbers(chunk, createRng(3));
    const out = printChunk(chunk);
    assert.deepEqual(execute(out).output, execute(src).output);
    assert.equal(analyze(parse(out)).diagnostics.length, 0);
  });

  test(`pases de expresiones: programa ${i}`, () => {
    const chunk = parse(src);
    transformExpressions(chunk, createRng(4), 1);
    const out = printChunk(chunk);
    assert.deepEqual(execute(out).output, execute(src).output);
  });

  test(`código muerto: programa ${i}`, () => {
    const chunk = parse(src);
    const rng = createRng(5);
    insertDeadCode(chunk, rng, 0.6, createNameGenerator(rng, new Set()));
    const out = printChunk(chunk);
    assert.deepEqual(execute(out).output, execute(src).output);
    assert.equal(analyze(parse(out)).diagnostics.length, 0);
  });

  test(`pipeline completo con todas las pasadas: programa ${i}`, () => {
    const { code } = obfuscate(src, { seed: 21, transformNumbers: true, transformExpressions: 0.5, deadCodeDensity: 0.4 });
    assert.deepEqual(execute(code).output, execute(src).output);
  });
}

test('código muerto nunca se ejecuta aunque su condición sea falsa para cualquier k', () => {
  const chunk = parse('print("ok")');
  insertDeadCode(chunk, createRng(1), 1, createNameGenerator(createRng(2), new Set()));
  const out = printChunk(chunk);
  assert.deepEqual(execute(out).output, ['ok']);
});

test('las pasadas reportan etapas en orden', () => {
  const stages: string[] = [];
  obfuscate('local x = 1\nprint(x == 1)', { seed: 1, transformNumbers: true, transformExpressions: 1, deadCodeDensity: 0.5, onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['parse', 'analyze', 'rename', 'numbers', 'expressions', 'dead-code', 'generate', 'verify']);
});
