import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, LuaError } from '../src/index.js';

const out = (src: string) => execute(src).output;

test('aritmética y formato de números', () => {
  assert.deepEqual(out('print(1 + 2 * 3, 7 / 2, 7 // 2, 2 ^ 10, 10 % 3)'), ['7\t3.5\t3\t1024\t1']);
});

test('concatenación y longitud', () => {
  assert.deepEqual(out('print("a" .. 1 .. "b", #"hola", #{1, 2, 3})'), ['a1b\t4\t3']);
});

test('variables locales, sombreado y globales', () => {
  assert.deepEqual(out('local x = 1\ndo local x = 2; print(x) end\nprint(x)\ny = 5\nprint(y)'), ['2', '1', '5']);
});

test('closures capturan variables por referencia', () => {
  const src = `
    local function counter()
      local n = 0
      return function() n = n + 1; return n end
    end
    local c = counter()
    c(); c()
    print(c())`;
  assert.deepEqual(out(src), ['3']);
});

test('recursión', () => {
  assert.deepEqual(out('local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end print(fib(15))'), ['610']);
});

test('bucles: while, repeat, numérico con paso negativo', () => {
  const src = `
    local i = 0
    while i < 3 do i = i + 1 end
    local j = 0
    repeat j = j + 2 until j >= 5
    local acc = {}
    for k = 5, 1, -2 do table.insert(acc, k) end
    print(i, j, table.concat(acc, ","))`;
  assert.deepEqual(out(src), ['3\t6\t5,3,1']);
});

test('break y continue', () => {
  const src = `
    local seen = {}
    for i = 1, 10 do
      if i % 2 == 0 then continue end
      if i > 7 then break end
      table.insert(seen, i)
    end
    print(table.concat(seen, " "))`;
  assert.deepEqual(out(src), ['1 3 5 7']);
});

test('return dentro de bucle genérico sale de la función', () => {
  const src = `
    local function find(t, v)
      for i, x in ipairs(t) do
        if x == v then return i end
      end
      return -1
    end
    print(find({4, 5, 6}, 5), find({4}, 9))`;
  assert.deepEqual(out(src), ['2\t-1']);
});

test('funciones variádicas y select', () => {
  const src = `
    local function sum(...)
      local s = 0
      for _, v in ipairs({...}) do s = s + v end
      return s, select("#", ...)
    end
    print(sum(1, 2, 3))`;
  assert.deepEqual(out(src), ['6\t3']);
});

test('métodos con self', () => {
  const src = `
    local Account = {}
    function Account:deposit(n) self.balance = (self.balance or 0) + n; return self end
    local a = {}
    setmetatable = nil
    Account.deposit(a, 5)
    print(a.balance)`;
  // Sin metatablas: se usa la función directamente.
  assert.deepEqual(out(src), ['5']);
});

test('operadores compuestos', () => {
  assert.deepEqual(out('local a = 2\na += 3\na *= 2\nlocal s = "x"\ns ..= "y"\nprint(a, s)'), ['10\txy']);
});

test('tablas: constructor mixto y expansión de la última expresión', () => {
  const src = `
    local function three() return 1, 2, 3 end
    local t = {three(), three()}
    print(#t, t[4], t.missing)`;
  assert.deepEqual(out(src), ['4\t3\tnil']);
});

test('pcall captura errores de ejecución', () => {
  const src = `
    local ok, msg = pcall(function() local x = nil; return x + 1 end)
    print(ok, type(msg))`;
  assert.deepEqual(out(src), ['false\tstring']);
});

test('error no capturado lanza LuaError', () => {
  assert.throws(() => execute('local t = nil\nprint(t.x)'), (e: any) => e instanceof Error && /index/.test(e.message));
});

test('límite de ejecución corta bucles infinitos', () => {
  assert.throws(() => execute('while true do end', { stepLimit: 1000 }), /límite/);
});

test('if-expresión y and/or con cortocircuito', () => {
  const src = `
    local calls = 0
    local function f() calls = calls + 1; return true end
    local a = false and f()
    local b = true or f()
    local c = if a == false then "yes" else "no"
    print(calls, c, nil or "d")`;
  assert.deepEqual(out(src), ['0\tyes\td']);
});

test('string.char y bit32.bxor', () => {
  assert.deepEqual(out('print(string.char(72, 105), bit32.bxor(5, 3))'), ['Hi\t6']);
});

test('script inválido se rechaza antes de ejecutar', () => {
  assert.throws(() => execute('break'), /E_BREAK_OUTSIDE_LOOP|script inválido/);
});
