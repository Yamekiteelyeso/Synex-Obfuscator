import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, LuaError } from '@synex/runtime';
import { runInVm, compileToLuauVm } from '../src/index.js';

/** Oráculo: el intérprete de referencia. La VM debe coincidir con él en salida y retornos. */
function same(src: string) {
  const ref = execute(src);
  const vm = runInVm(src);
  assert.deepEqual(vm.output, ref.output);
  assert.deepEqual(vm.returned, ref.returned);
}

const PROGRAMS: Record<string, string> = {
  arithmetic: 'print(1 + 2 * 3, 7 / 2, 7 // 2, 2 ^ 10, 10 % 3, -4 + 1)',
  concat: 'print("a" .. 1 .. "b", #"hola", #{1, 2, 3}, not nil, 1 == 1, "a" < "b")',
  shadowing: 'local x = 1\ndo local x = 2; print(x) end\nprint(x)\ny = 5\nprint(y)',
  closures: `
    local function counter()
      local n = 0
      return function() n = n + 1; return n end
    end
    local c = counter()
    c(); c()
    print(c())`,
  sharedUpvalue: `
    local function pair()
      local v = 0
      return function() v = v + 1 end, function() return v end
    end
    local inc, get = pair()
    inc(); inc()
    print(get())`,
  loopClosures: `
    local fns = {}
    for i = 1, 3 do fns[i] = function() return i end end
    print(fns[1](), fns[2](), fns[3]())`,
  recursion: 'local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end print(fib(15))',
  whileRepeat: `
    local i = 0
    while i < 3 do i = i + 1 end
    local j = 0
    repeat j = j + 2 until j >= 5
    local acc = {}
    for k = 5, 1, -2 do table.insert(acc, k) end
    print(i, j, table.concat(acc, ","))`,
  breakContinue: `
    local seen = {}
    for i = 1, 10 do
      if i % 2 == 0 then continue end
      if i > 7 then break end
      table.insert(seen, i)
    end
    print(table.concat(seen, " "))`,
  repeatContinue: `
    local n, out = 0, {}
    repeat
      n = n + 1
      if n == 2 then continue end
      table.insert(out, n)
    until n >= 4
    print(table.concat(out, ","))`,
  returnFromLoop: `
    local function find(t, v)
      for i, x in ipairs(t) do
        if x == v then return i end
      end
      return -1
    end
    print(find({4, 5, 6}, 5), find({4}, 9))`,
  varargs: `
    local function sum(...)
      local s = 0
      for _, v in ipairs({...}) do s = s + v end
      return s, select("#", ...)
    end
    print(sum(1, 2, 3))`,
  multiAssign: `
    local a, b, c = 1, 2
    a, b = b, a
    print(a, b, c)
    local function two() return 10, 20 end
    local x, y, z = two()
    print(x, y, z)
    local p, q = two(), 99
    print(p, q)`,
  methods: `
    local Stack = {}
    function Stack:push(v) self.items[#self.items + 1] = v; return self end
    function Stack:top() return self.items[#self.items] end
    local s = { items = {}, push = Stack.push, top = Stack.top }
    s:push("a")
    s:push("b"):push("c")
    print(s:top(), #s.items)`,
  compound: 'local a = 2\na += 3\na *= 2\nlocal s = "x"\ns ..= "y"\nlocal t = {n = 1}\nt.n += 5\nprint(a, s, t.n)',
  tableCtor: `
    local function three() return 1, 2, 3 end
    local t = {three(), three()}
    print(#t, t[4], t.missing)`,
  andOr: `
    local calls = 0
    local function f() calls = calls + 1; return true end
    local a = false and f()
    local b = true or f()
    local c = if a == false then "yes" else "no"
    print(calls, c, nil or "d", b)`,
  ifExpr: `
    local function sign(n) return if n > 0 then "pos" elseif n < 0 then "neg" else "zero" end
    print(sign(3), sign(-2), sign(0))`,
  genericForPairs: `
    local t = {10, 20, x = 1}
    local count = 0
    for k, v in pairs(t) do count = count + 1 end
    print(count)`,
  returnValues: `
    local name = "obf"
    local function make(x) return name .. x, x * 2 end
    local a, b = make(21)
    return a, b`,
  fieldFunctions: `
    local M = {}
    function M.add(a, b) return a + b end
    function M.apply(f, x) return f(x, x) end
    print(M.add(2, 3), M.apply(M.add, 4))`,
  nestedClosureWrite: `
    local total = 0
    local function outer()
      local function inner(n) total = total + n end
      inner(2); inner(3)
    end
    outer()
    print(total)`,
  pcallError: `
    local ok, msg = pcall(function() local x = nil; return x + 1 end)
    print(ok, type(msg))`,
};

for (const [name, src] of Object.entries(PROGRAMS)) {
  test(`VM coincide con el intérprete: ${name}`, () => same(src));
}

test('VM: error en tiempo de ejecución es LuaError', () => {
  assert.throws(() => runInVm('local t = nil\nprint(t.x)'), (e: any) => e instanceof LuaError && /index/.test(e.message));
});

test('VM: límite de ejecución corta bucles infinitos', () => {
  assert.throws(() => runInVm('while true do end', { stepLimit: 1000 }), /límite/);
});

test('VM: recursión profunda termina con stack overflow', () => {
  assert.throws(() => runInVm('local function f() return f() end f()'), /stack overflow/);
});

// Ofuscado + VM debe coincidir con el original en el intérprete de referencia.
import { obfuscate } from '@synex/transformations';
for (const [name, src] of Object.entries(PROGRAMS)) {
  for (const seed of [1, 7]) {
    test(`ofuscado ejecutado en la VM coincide: ${name} (semilla ${seed})`, () => {
      const ref = execute(src);
      const { code } = obfuscate(src, { seed });
      const vm = runInVm(code);
      assert.deepEqual(vm.output, ref.output);
      assert.deepEqual(vm.returned, ref.returned);
    });
  }
}


test('emisor Luau: usa el entorno Roblox y soporta objetos nativos', () => {
  const code = compileToLuauVm('local x = game:GetService("Workspace")\nreturn x');
  assert.match(code, /getfenv/);
  assert.match(code, /getgenv/);
  assert.match(code, /local function unstr/);
  assert.match(code, /local function decodeOperand/);
  assert.match(code, /decodeOperand\(ins\[6\], ip, 6\)/);
  assert.doesNotMatch(code, /P\.k\[/);
  assert.ok(code.includes('unstr('));
  assert.equal(compileToLuauVm('local x = game:GetService("Workspace")\nreturn x'), code);
  assert.notEqual(compileToLuauVm('local x = game:GetService("Workspace")\nreturn x', 99), code);
  assert.doesNotMatch(code, /Workspace/);
  assert.match(code, /local ENV/);
  assert.match(code, /return o\[k\]/);
  assert.match(code, /f\(tbl\.unpack/);
  assert.doesNotMatch(code, /typefn\(o\) ~= "table"/);
});


test('emisor Luau: aleatoriza los nombres de campos del prototipo por semilla', () => {
  const src = 'local function f(x) return x + 1 end return f(4)';
  const a = compileToLuauVm(src, 123);
  const b = compileToLuauVm(src, 123);
  const otherSeed = compileToLuauVm(src, 124);
  assert.equal(a, b);
  assert.notEqual(a, otherSeed);
  assert.ok(!['__KEY_NP__', '__KEY_VA__', '__KEY_CODE__', '__KEY_CONST__', '__KEY_CHILD__', '__KEY_UP__'].some((field) => a.includes(field)));
});

test('emisor Luau: las cadenas Unicode no aparecen en texto plano dentro de la VM', () => {
  const code = compileToLuauVm('print("こんにちは 🌎")', 321);
  assert.doesNotMatch(code, /こんにちは|🌎/);
  assert.ok(code.includes('unstr('));
});


test('emisor Luau: los operandos del bytecode cambian por instrucción y semilla', () => {
  const src = 'local function f(x) return x + 7 end return f(12)';
  const a = compileToLuauVm(src, 77);
  const b = compileToLuauVm(src, 78);
  assert.match(a, /OPERAND_SEED = 77/);
  assert.notEqual(a, b);
  assert.match(a, /bytecode truncado o alterado/);
  assert.match(a, /límite de pila superado/);
});
