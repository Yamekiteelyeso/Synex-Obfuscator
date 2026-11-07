import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@synex/parser';
import { analyze, analyzeSource } from '../src/index.js';

const diags = (src: string) => analyze(parse(src)).diagnostics.map((d) => d.code);

test('local resuelve a su declaración y cuenta lecturas', () => {
  const r = analyze(parse('local a = 1\nprint(a + a)'));
  const sym = r.symbols.find((s) => s.name === 'a');
  assert.ok(sym);
  assert.equal(sym.reads, 2);
  assert.equal(r.globals.has('print'), true);
  assert.equal(r.globals.has('a'), false);
});

test('ámbito: un bloque interior sombrea la variable exterior', () => {
  const r = analyze(parse('local x = 1\ndo local x = 2; print(x) end\nprint(x)'));
  const xs = r.symbols.filter((s) => s.name === 'x');
  assert.equal(xs.length, 2);
  const refs = [...r.references.entries()].filter(([n]) => n.kind === 'Name' && n.name === 'x');
  assert.equal(refs[0][1], xs[1]);
  assert.equal(refs[1][1], xs[0]);
});

test('local function es visible dentro de su propio cuerpo (recursión)', () => {
  const r = analyze(parse('local function f(n) return f(n - 1) end'));
  assert.equal(r.globals.has('f'), false);
});

test('una variable no se ve antes de su declaración', () => {
  const r = analyze(parse('print(y)\nlocal y = 1'));
  assert.equal(r.globals.has('y'), true);
});

test('en "local x = x" el lado derecho usa la variable exterior', () => {
  const r = analyze(parse('local x = 1\ndo local x = x end'));
  assert.equal(r.globals.size, 0);
});

test('asignación marca la variable como reasignada', () => {
  const r = analyze(parse('local a = 1\na = 2\nlocal b = 3'));
  assert.equal(r.symbols.find((s) => s.name === 'a')?.reassigned, true);
  assert.equal(r.symbols.find((s) => s.name === 'b')?.reassigned, false);
});

test('compuesto cuenta como lectura y reasignación', () => {
  const r = analyze(parse('local a = 1\na += 1'));
  const a = r.symbols.find((s) => s.name === 'a')!;
  assert.equal(a.reassigned, true);
  assert.equal(a.reads, 1);
});

test('parámetros y self implícito se declaran en la función', () => {
  const r = analyze(parse('function M:go(x) return self, x end'));
  const kinds = r.symbols.map((s) => `${s.name}:${s.kind}`);
  assert.deepEqual(kinds.sort(), ['self:self', 'x:param'].sort());
});

test('variable de bucle numérico solo es visible dentro del bucle', () => {
  const r = analyze(parse('for i = 1, 3 do print(i) end\nprint(i)'));
  assert.equal(r.globals.has('i'), true);
});

test('la condición de repeat-until ve las locales del cuerpo', () => {
  const r = analyze(parse('repeat local done = true until done'));
  assert.equal(r.globals.has('done'), false);
});

test('break fuera de bucle se reporta', () => {
  assert.deepEqual(diags('break'), ['E_BREAK_OUTSIDE_LOOP']);
});

test('break dentro de función anidada en bucle se reporta', () => {
  assert.deepEqual(diags('while true do local f = function() break end end'), ['E_BREAK_OUTSIDE_LOOP']);
});

test('continue dentro de bucle es válido', () => {
  assert.deepEqual(diags('for i = 1, 2 do if i == 1 then continue end end'), []);
});

test('... fuera de función vararg se reporta', () => {
  assert.deepEqual(diags('local x = ...'), ['E_VARARG_OUTSIDE']);
});

test('... dentro de función vararg es válido', () => {
  assert.deepEqual(diags('local function f(...) return ... end'), []);
});

test('analyzeSource lanza error con la posición del primer problema', () => {
  assert.throws(() => analyzeSource('local a = 1\nbreak'), (e: any) => e.code === 'E_BREAK_OUTSIDE_LOOP' && e.line === 2);
});

test('analyzeSource devuelve el análisis si el código es válido', () => {
  const r = analyzeSource('local t = {}\nfor _, v in ipairs(t) do print(v) end');
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.globals.has('ipairs'), true);
});
