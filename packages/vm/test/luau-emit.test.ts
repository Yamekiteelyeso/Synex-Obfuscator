import { test, describe } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parse } from '@synex/parser';
import { compileToLuauVm, opcodeTable } from '../src/index.js';
import { lua54Available, runLua54 } from '../../../tools/lua54/lua54.js';

/**
 * Equivalencia real: el programa original y su versión emitida como VM se
 * ejecutan en Lua 5.4 y deben producir la misma salida.
 */
const PROGRAMS: Record<string, string> = {
  arithmetic: 'print(1 + 2 * 3, 7 / 2, 7 // 2, 2 ^ 10, 10 % 3, -4 + 1, 2 ^ -1)',
  comparisons: 'print(1 == 1, 1 ~= 2, 1 < 2, 2 <= 2, 3 > 2, 2 >= 3, "a" < "b", not nil)',
  concat: 'print("a" .. 1 .. "b", #"hola", #{1, 2, 3}, ("x"):rep(3))',
  locals_shadow: 'local x = 1\ndo local x = 2; print(x) end\nprint(x)\ny = 5\nprint(y)',
  closures: `
    local function counter()
      local n = 0
      return function() n = n + 1; return n end
    end
    local c = counter()
    c(); c()
    print(c())`,
  shared_upvalue: `
    local function pair()
      local v = 0
      return function() v = v + 1 end, function() return v end
    end
    local inc, get = pair()
    inc(); inc()
    print(get())`,
  varargs: `
    local function f(...)
      local n = select("#", ...)
      local first = ...
      return n, first, ...
    end
    print(f(7, 8, 9))
    print((f()))`,
  multiple_returns: `
    local function three() return 1, 2, 3 end
    local a, b, c, d = three()
    print(a, b, c, d)
    print((three()))
    print(({three()})[3] == 3, #{three(), three()})`,
  tables: `
    local t = {10, 20, x = "y", [5] = 50}
    t.z = t.x .. "!"
    t[#t + 1] = 30
    for i, v in ipairs(t) do print(i, v) end
    print(t.z, t[5], #t)`,
  methods: `
    local Acc = {}
    Acc.__index = Acc
    function Acc.new(n) return setmetatable({n = n}, Acc) end
    local obj = {n = 1, get = function(self) return self.n * 10 end}
    print(obj:get(), obj.get(obj))`,
  loops: `
    local s = 0
    for i = 10, 1, -3 do s = s + i end
    for i = 1, 3 do s = s + i * 100 end
    local k = 0
    while true do k = k + 1; if k > 4 then break end end
    repeat k = k - 1 until k <= 0
    print(s, k)`,
  generic_for_break: `
    local out = {}
    for i, v in ipairs({5, 6, 7, 8}) do
      if v > 7 then break end
      out[#out + 1] = v * i
    end
    print(table.concat(out, ","))`,
  recursion: `
    local function fib(n)
      if n < 2 then return n end
      return fib(n - 1) + fib(n - 2)
    end
    print(fib(15))`,
  pcall_closure_error: `
    local function failOnce() error("expected") end
    local ok = pcall(failOnce)
    local function afterError() return 42 end
    print(ok, afterError())
  `,
  string_lib: 'print(string.upper("abc"), string.char(72, 105), string.byte("A"), ("%d"):format(42))',
  if_chain: `
    local function grade(n)
      if n >= 90 then return "A" elseif n >= 70 then return "B" else return "C" end
    end
    print(grade(95), grade(75), grade(10))`,
};

describe('VM Luau emitida: equivalencia en Lua 5.4', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    test(name, () => {
      const orig = runLua54(src);
      assert.ok(orig.ok, `original: ${orig.error}`);
      const emitted = compileToLuauVm(src, 7);
      const got = runLua54(emitted);
      assert.ok(got.ok, `VM: ${got.error}`);
      assert.equal(got.stdout, orig.stdout);
    });
  }
});

describe('VM Luau emitida: propiedades', () => {
  test('la salida es Luau sintácticamente válido', () => {
    const out = compileToLuauVm(PROGRAMS.closures, 3);
    assert.doesNotThrow(() => parse(out));
  });

  test('no quedan marcadores sin sustituir', () => {
    const out = compileToLuauVm(PROGRAMS.loops, 3);
    assert.doesNotMatch(out, /OP_[A-Z]+|__MAIN__/);
  });

  test('baraja el orden real del dispatcher por build y conserva determinismo', () => {
    const a = compileToLuauVm(PROGRAMS.loops, 2101);
    const b = compileToLuauVm(PROGRAMS.loops, 2102);
    const armOrder = (code: string) =>
      [...code.matchAll(/(?:if|elseif) op == (\d+) then/g)].map((match) => match[1]);
    assert.deepEqual(armOrder(a), armOrder(compileToLuauVm(PROGRAMS.loops, 2101)));
    assert.notDeepEqual(armOrder(a), armOrder(b));
    assert.equal(armOrder(a).length, 52);
  });

  test('cada build asigna códigos distintos', () => {
    const a = opcodeTable(1);
    const b = opcodeTable(2);
    assert.notDeepEqual(a, b);
    const codes = new Set(Object.values(a));
    assert.equal(codes.size, Object.keys(a).length, 'códigos únicos');
  });

  test('la misma semilla produce la misma salida', () => {
    assert.equal(compileToLuauVm(PROGRAMS.loops, 5), compileToLuauVm(PROGRAMS.loops, 5));
  });

  test('usa unpack compatible con table.unpack y unpack global', () => {
    const out = compileToLuauVm(PROGRAMS.varargs, 9);
    assert.match(out, /local unpackfn = \(tbl and tbl\.unpack\) or unpack/);
    assert.doesNotMatch(out, /tbl\.unpack\(/);
  });

  test('restaura profundidad al capturar errores de closures con pcall', () => {
    const out = compileToLuauVm(PROGRAMS.pcall_closure_error, 9);
    assert.match(out, /local ok, result = pcallfn\(function\(\)/);
    assert.match(out, /if not ok then errorfn\(result, 0\) end/);
  });

  test('valida la estructura de instrucciones y los destinos de salto en runtime', () => {
    const out = compileToLuauVm(PROGRAMS.loops, 11);
    assert.match(out, /if typefn\(ins\) ~= "table" or #ins ~= 9 then fail\("instrucción corrupta"\) end/);
    assert.match(out, /local function instructionIntact/);
    assert.match(out, /integridad comprometida: instrucción alterada/);
    assert.match(out, /if typefn\(value\) ~= "number" or value ~= floor\(value\) then fail\("operando corrupto"\) end/);
    assert.match(out, /salto fuera del prototipo/);
  });

});
