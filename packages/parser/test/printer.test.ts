import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, printChunk, escapeString, tokenize } from '../src/index.js';

/** Quita posiciones para comparar estructuras. */
const strip = (x: unknown): unknown =>
  JSON.parse(JSON.stringify(x, (k, v) => (k === 'line' || k === 'column' || k === 'endLine' ? undefined : v)));

const roundTrip = (src: string) => {
  const ast = parse(src);
  const printed = printChunk(ast);
  return { printed, same: JSON.stringify(strip(parse(printed))) === JSON.stringify(strip(ast)) };
};

const PROGRAM = `
local a, b: number = 1, 2
local function fib(n: number): number
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end
local t = { x = 1, [2] = "two", 3; f = function(...) return ... end }
for i = 1, 10, 2 do if i == 5 then continue end end
for k, v in pairs(t) do print(k, v) end
local obj = {}
function obj.go(self) return self.x end
function obj:run(a) return a end
obj.n += 1
obj.s ..= "x"
repeat a = a - 1 until a <= 0
while a > 0 do a = a - 1 end
local g = (a + b) * -2 ^ 2 .. "s"
local h = if a > b then a elseif a == b then 0 else b
local v = (a :: any)
type Pair<T> = { first: T, second: T? }
export type Fn = (number, string) -> (boolean, number)
`;

test('round-trip: parse(print(parse(src))) conserva la estructura', () => {
  assert.equal(roundTrip(PROGRAM).same, true);
});

test('round-trip de precedencias y asociatividad', () => {
  for (const src of ['x = (1 + 2) * 3', 'x = -(2 ^ 2)', 'x = (-2) ^ 2', 'x = a .. (b .. c)', 'x = (a .. b) .. c',
    'x = not (a and b) or c', 'x = #(t) + 1']) {
    assert.equal(roundTrip(src).same, true, src);
  }
});

test('una sentencia que empieza por "(" recibe ";" para evitar ambigüedad', () => {
  const { printed, same } = roundTrip('a = b;(f)()');
  assert.equal(same, true);
  assert.match(printed, /;\(/);
});

test('escapeString produce ASCII con escapes decimales para bytes no imprimibles', () => {
  assert.equal(escapeString('a"b\\c\n'), '"a\\"b\\\\c\\n"');
  assert.equal(escapeString(String.fromCharCode(200)), '"\\200"');
});

test('caracteres UTF-8 se tratan como bytes y se reimprimen como escapes', () => {
  const toks = tokenize('"é"');
  assert.equal(toks[0].value.length, 2);
  const { printed, same } = roundTrip('x = "é\\u{1F600}"');
  assert.equal(same, true);
  assert.ok(/^[\x20-\x7e\n]*$/.test(printed), 'la salida es ASCII imprimible');
});

test('stringLiteral reemplaza literales pero no las claves con punto', () => {
  const ast = parse('x = obj.key + "lit" + t["k"]');
  const out = printChunk(ast, { stringLiteral: (v) => `D("${v}")` });
  assert.match(out, /obj\.key/);
  assert.match(out, /D\("lit"\)/);
  assert.match(out, /t\[D\("k"\)\]/);
});

test('tipos: uniones, funciones y genéricos se reimprimen', () => {
  const { same, printed } = roundTrip('local f: (number | string)? = nil\ntype M<T> = { [string]: T }');
  assert.equal(same, true);
  assert.match(printed, /\(number \| string\)\?/);
});
