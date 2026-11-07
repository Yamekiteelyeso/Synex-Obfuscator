import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/index.js';
import type * as A from '../src/index.js';

const first = (src: string): A.Stat => parse(src).body[0];

test('local con varias variables y valores', () => {
  const s = first('local a, b = 1, "x"') as A.LocalStat;
  assert.equal(s.kind, 'Local');
  assert.deepEqual(s.bindings.map((b) => b.name), ['a', 'b']);
  assert.equal(s.values.length, 2);
});

test('precedencia: ^ es más fuerte que la negación unaria y asociativo por la derecha', () => {
  const s = first('x = -2 ^ 3 ^ 2') as A.AssignStat;
  const v = s.values[0] as A.UnaryExpr;
  assert.equal(v.kind, 'Unary');
  const pow = v.operand as A.BinaryExpr;
  assert.equal(pow.op, '^');
  assert.equal((pow.right as A.BinaryExpr).op, '^');
});

test('precedencia: * antes que +, y .. es asociativo por la derecha', () => {
  const s = first('x = 1 + 2 * 3 .. "a" .. "b"') as A.AssignStat;
  const top = s.values[0] as A.BinaryExpr;
  assert.equal(top.op, '..');
  assert.equal((top.left as A.BinaryExpr).op, '+');
  assert.equal((top.right as A.BinaryExpr).op, '..');
});

test('operadores compuestos de Luau', () => {
  const s = first('a.b += 1') as A.CompoundAssignStat;
  assert.equal(s.kind, 'CompoundAssign');
  assert.equal(s.op, '+');
  assert.equal(s.target.kind, 'Index');
  assert.equal((first('x ..= "y"') as A.CompoundAssignStat).op, '..');
  assert.equal((first('x //= 2') as A.CompoundAssignStat).op, '//');
});

test('continue como sentencia', () => {
  const loop = first('for i = 1, 3 do continue end') as A.NumericForStat;
  assert.equal(loop.body[0].kind, 'Continue');
});

test('anotaciones de tipo en locales, parámetros y retorno', () => {
  const s = first('local function f(a: number, b: string?): {x: number} return {x = 1} end') as A.LocalFunctionStat;
  assert.equal(s.func.params[0].type?.kind, 'TypeRef');
  assert.equal(s.func.params[1].type?.kind, 'TypeOptional');
  assert.equal(s.func.returnTypes?.[0].kind, 'TypeTable');
});

test('declaración de tipo exportada con genéricos y unión', () => {
  const s = first('export type Pair<T> = {first: T, second: T | nil}') as A.TypeAliasStat;
  assert.equal(s.kind, 'TypeAlias');
  assert.equal(s.exported, true);
  assert.deepEqual(s.generics, ['T']);
});

test('tipo de función y retorno múltiple', () => {
  const s = first('type F = (number, string) -> (boolean, number)') as A.TypeAliasStat;
  assert.equal(s.type.kind, 'TypeFunction');
  assert.equal((s.type as A.TypeFunction).returns.length, 2);
});

test('aserción de tipo con ::', () => {
  const s = first('local x = y :: number') as A.LocalStat;
  assert.equal(s.values[0].kind, 'TypeAssert');
});

test('expresión if de Luau', () => {
  const s = first('local x = if a then 1 elseif b then 2 else 3') as A.LocalStat;
  const e = s.values[0] as A.IfExpr;
  assert.equal(e.kind, 'IfExpr');
  assert.equal(e.elseifs.length, 1);
});

test('llamadas, métodos y encadenado de índices', () => {
  const s = first('obj.a[1]:run("x"):stop{k = 1}') as A.CallStat;
  assert.equal(s.kind, 'CallStat');
  assert.equal(s.call.kind, 'MethodCall');
});

test('función con dos puntos añade self implícito', () => {
  const s = first('function M.a.b:c(x) return x end') as A.FunctionStat;
  assert.equal(s.method, true);
  assert.equal(s.func.params[0].name, 'self');
  assert.equal(s.func.params[0].implicit, true);
});

test('for genérico con anotaciones', () => {
  const s = first('for k: string, v in pairs(t) do end') as A.GenericForStat;
  assert.equal(s.bindings.length, 2);
  assert.equal(s.bindings[0].type?.kind, 'TypeRef');
});

test('tabla con campos posicionales, nombrados y con clave', () => {
  const s = first('x = {1, a = 2, [3] = 4; 5}') as A.AssignStat;
  const t = s.values[0] as A.TableExpr;
  assert.deepEqual(t.fields.map((f) => f.kind), ['Positional', 'Named', 'Keyed', 'Positional']);
});

test('return debe ser la última sentencia del bloque', () => {
  assert.throws(() => parse('do return 1 print(2) end'), (e: any) => e.code === 'E_PARSE');
});

test('repeat-until con condición', () => {
  const s = first('repeat x = x + 1 until x > 3') as A.RepeatStat;
  assert.equal(s.kind, 'Repeat');
});

test('sentencia que no es llamada ni asignación produce error', () => {
  assert.throws(() => parse('x'), (e: any) => e.code === 'E_PARSE');
});

test('error reporta línea y columna', () => {
  try {
    parse('local a = 1\nlocal = 2');
    assert.fail('debía fallar');
  } catch (e: any) {
    assert.equal(e.line, 2);
  }
});

test('"type" puede usarse como identificador normal', () => {
  const s = first('local type = 1') as A.LocalStat;
  assert.equal(s.bindings[0].name, 'type');
});
