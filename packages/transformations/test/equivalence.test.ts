import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '@synex/runtime';
import { obfuscate } from '../src/index.js';

/**
 * Pruebas de equivalencia: el script original y el ofuscado deben producir
 * la misma salida (print) y los mismos valores devueltos en el intérprete de referencia.
 */
const PROGRAMS: Record<string, string> = {
  basics: `
    local count = 0
    local function bump(step) count = count + step; return count end
    for i = 1, 3 do bump(i) end
    print(count, "done")`,
  closures: `
    local function counter(start)
      local n = start
      return function(step) n = n + step; return n end
    end
    local a, b = counter(10), counter(100)
    a(1); b(5); a(1)
    print(a(0), b(0))`,
  recursion: `
    local memo = {}
    local function fib(n)
      if n < 2 then return n end
      if memo[n] then return memo[n] end
      local v = fib(n - 1) + fib(n - 2)
      memo[n] = v
      return v
    end
    print(fib(30), fib(50))`,
  strings: `
    local greeting = "hello"
    local target = "world"
    local parts = {}
    for i = 1, 3 do table.insert(parts, greeting .. " " .. target .. " #" .. i) end
    print(table.concat(parts, "; "))`,
  methods: `
    local Stack = {}
    function Stack:push(v) self.items[#self.items + 1] = v; return self end
    function Stack:top() return self.items[#self.items] end
    local s = { items = {}, push = Stack.push, top = Stack.top }
    s:push("a")
    s:push("b"):push("c")
    print(s:top(), #s.items)`,
  varargs: `
    local function pack2(...)
      local t = {...}
      local total = 0
      for _, v in ipairs(t) do total = total + v end
      return total, select("#", ...)
    end
    print(pack2(1, 2, 3, 4))`,
  controlFlow: `
    local found = {}
    for i = 1, 20 do
      if i % 3 == 0 then continue end
      if i > 10 then break end
      found[#found + 1] = i
    end
    local n = 0
    repeat n = n + 1 until n >= 4
    print(table.concat(found, ","), n)`,
  returnValues: `
    local name = "obf"
    local function make(x) return name .. x, x * 2 end
    local a, b = make(21)
    return a, b`,
};

for (const [name, src] of Object.entries(PROGRAMS)) {
  for (const seed of [1, 2, 3, 17, 4242]) {
    test(`equivalencia ${name} (semilla ${seed})`, () => {
      const original = execute(src);
      const { code } = obfuscate(src, { seed });
      const obfuscated = execute(code);
      assert.deepEqual(obfuscated.output, original.output);
      assert.deepEqual(obfuscated.returned, original.returned);
    });
  }
}

test('equivalencia: solo renombrado', () => {
  const src = PROGRAMS.closures;
  const { code } = obfuscate(src, { seed: 9, encodeStrings: false });
  assert.deepEqual(execute(code).output, execute(src).output);
});

test('equivalencia: solo cadenas', () => {
  const src = PROGRAMS.strings;
  const { code } = obfuscate(src, { seed: 9, renameIdentifiers: false });
  assert.deepEqual(execute(code).output, execute(src).output);
});

test('equivalencia: el código ofuscado no contiene el texto original de las cadenas', () => {
  const src = PROGRAMS.strings;
  const { code } = obfuscate(src, { seed: 5 });
  assert.doesNotMatch(code, /"hello"/);
  assert.doesNotMatch(code, /"world"/);
});

test('equivalencia: un error en tiempo de ejecución es el mismo en ambos', () => {
  const src = 'local t = nil\nprint(t.x)';
  const { code } = obfuscate(src, { seed: 3 });
  assert.throws(() => execute(src), /index/);
  assert.throws(() => execute(code), /index/);
});
