import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  assert.match(code, /local function protoIntact/);
  assert.match(code, /local function blockIntact/);
  assert.match(code, /integridad comprometida: bloque virtual alterado/);
  assert.match(code, /índice de bloques corrupto/);
  assert.match(code, /integridad comprometida: prototipo alterado/);
  assert.match(code, /local function constant/);
  assert.match(code, /#ins ~= 9/);
  assert.match(code, /local function instructionIntact/);
  assert.match(code, /integridad comprometida: instrucción alterada/);
  assert.match(code, /decodeOperand\(ins\[7\], ip, 7, protoSalt\)/);
  assert.match(code, /sucesora fuera del prototipo/);
  assert.match(code, /function\(\) return/);
  assert.match(code, /constIntact\(b,/);
  assert.ok(code.includes('decodeOperand(ins[6], ip, 6, protoSalt)'));
  assert.ok(!code.includes('P.k['));
  assert.ok(code.includes('unstr('));
  assert.equal(compileToLuauVm('local x = game:GetService("Workspace")\nreturn x'), code);
  assert.notEqual(compileToLuauVm('local x = game:GetService("Workspace")\nreturn x', 99), code);
  assert.doesNotMatch(code, /Workspace/);
  assert.match(code, /local ENV/);
  assert.match(code, /return o\[k\]/);
  assert.match(code, /f\(unpackfn/);
  assert.match(code, /local unpackfn = \(tbl and tbl\.unpack\) or unpack/);
  assert.doesNotMatch(code, /typefn\(o\) ~= "table"/);
});


test('emisor Luau: oculta APIs de introspección de entorno al script virtual', () => {
  const source = 'print(getfenv, getgenv, getrenv, getreg, debug, hookfunction, getrawmetatable)';
  const emitted = compileToLuauVm(source, 654321);
  assert.match(emitted, /local BLOCKED_ENV/);
  assert.match(emitted, /acceso de entorno bloqueado/);
  assert.match(emitted, /rawgetfn\(executorEnv, key\)/);
  const hasLua54 = spawnSync('lua5.4', ['-v'], { encoding: 'utf8' }).status === 0;
  if (hasLua54) {
    const output = execFileSync('lua5.4', ['-'], { input: emitted, encoding: 'utf8', timeout: 5000 });
    assert.equal(output.trim(), ['nil', 'nil', 'nil', 'nil', 'nil', 'nil', 'nil'].join(String.fromCharCode(9)));
  }
});

test('emisor Luau: aleatoriza los nombres de campos del prototipo por semilla', () => {
  const src = 'local function f(x) return x + 1 end return f(4)';
  const a = compileToLuauVm(src, 123);
  const b = compileToLuauVm(src, 123);
  const otherSeed = compileToLuauVm(src, 124);
  assert.equal(a, b);
  assert.notEqual(a, otherSeed);
  assert.ok(!['__KEY_NP__', '__KEY_VA__', '__KEY_CODE__', '__KEY_CONST__', '__KEY_CHILD__', '__KEY_UP__', '__KEY_SALT__'].some((field) => a.includes(field)));
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

test('emisor Luau: cifra de forma reversible el metadato de línea', () => {
  const sourceLine = 12345;
  const src = '\n'.repeat(sourceLine - 1) + "print('line marker')";
  const emitted = compileToLuauVm(src, 1234567, { stepLimit: 1 });
  assert.match(emitted, /local lineMultiplier = 17/);
  assert.match(emitted, /local lineOffset = \(OPERAND_SEED \+ protoSalt \* 65537\) % 1000003/);
  assert.match(emitted, /curLine = floor\(\(lineToken - lineOffset\) \/ lineMultiplier\)/);
  assert.doesNotMatch(emitted, /,12345,/);
  if (hasLua54) {
    let stderr = '';
    try {
      execFileSync('lua5.4', ['-'], { input: emitted, encoding: 'utf8', timeout: 7000 });
    } catch (error) {
      stderr = String((error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '');
    }
    assert.match(stderr, /línea 12345: límite de ejecución superado/);
  }
});

test('emisor Luau: oculta constantes numéricas con un decoder IEEE-754', () => {
  const source = 'local a = 987654321\nlocal b = 123.125\nprint(a, b, -a)';
  const emitted = compileToLuauVm(source, 778899);
  assert.match(emitted, /local function unnum/);
  assert.doesNotMatch(emitted, /987654321|123\.125/);
  if (hasLua54) {
    const output = execFileSync('lua5.4', ['-'], { input: emitted, encoding: 'utf8', timeout: 7000 });
    assert.equal(output.trim(), ['987654321', '123.125', '-987654321'].join(String.fromCharCode(9)));
  }
});

test('emisor Luau: los sellos de prototipo y bloque usan doble acumulador', () => {
  const emitted = compileToLuauVm('local x = 1\nprint(x)', 90817);
  assert.match(emitted, /local hashA =/);
  assert.match(emitted, /local hashB =/);
  assert.match(emitted, /hashB == seal\[2\]/);
  assert.match(emitted, /hashB == descriptor\[2\]/);
});


const hasLua54 = spawnSync('lua5.4', ['-v'], { encoding: 'utf8' }).status === 0;

test('VM emitida: segmenta cadenas largas con claves distintas y las reconstruye correctamente', { skip: !hasLua54 }, () => {
  const value = 'Synex::fragmented::Unicode::GLOBE::0123456789::protection';
  const escapedValue = value;
  const source = `local value = "${escapedValue}"\nprint(value)`;
  const emitted = compileToLuauVm(source, 884422);
  const chunks = (emitted.match(/local b=\{/g) ?? []).length;
  assert.ok(chunks >= 5, `se esperaban varios fragmentos, se emitieron ${chunks}`);
  assert.doesNotMatch(emitted, /Synex::fragmented::Unicode|0123456789/);
  const output = execFileSync('lua5.4', ['-'], { input: emitted, encoding: 'utf8', timeout: 7000 });
  assert.equal(output.trim(), value);
});

test('VM emitida: detecta alteración de bytes de constantes antes de reconstruirlas', { skip: !hasLua54 }, () => {
  const emitted = compileToLuauVm('print("Synex protected constant")', 556677);
  const mainStart = emitted.indexOf('local MAIN = {');
  const payload = /local b=\{(\d+)/.exec(emitted.slice(mainStart));
  assert.ok(mainStart >= 0 && payload);
  const numberStart = mainStart + payload.index + 'local b={'.length;
  const tampered = emitted.slice(0, numberStart)
    + String((Number(payload[1]) + 1) % 256)
    + emitted.slice(numberStart + payload[1].length);
  assert.throws(
    () => execFileSync('lua5.4', ['-'], { input: tampered, encoding: 'utf8', timeout: 7000 }),
    /integridad comprometida: constante alterada/,
  );
});

test('VM emitida: ejecuta bytecode en Lua 5.4 real', { skip: !hasLua54 }, () => {
  const source = [
    'local function add(a, b) return a + b end',
    'local label = "Synex VM"',
    'local original = 42',
    'local copied = original',
    'local object = {value = add(20, 22)}',
    'print(label, object.value, copied)',
  ].join(String.fromCharCode(10));
  const emitted = compileToLuauVm(source, 918273);
  const output = execFileSync('lua5.4', ['-'], { input: emitted, encoding: 'utf8', timeout: 5000 });
  assert.ok(emitted.includes('slots[b + 1] = slots[a + 1]'));
  assert.equal(output.trim(), ['Synex VM', '42', '42'].join(String.fromCharCode(9)));
  const mainMarker = emitted.indexOf('local MAIN = {');
  assert.ok(mainMarker >= 0);
  const numeric = /\d+/.exec(emitted.slice(mainMarker + 'local MAIN = {'.length));
  assert.ok(numeric);
  const tamperAt = mainMarker + 'local MAIN = {'.length + numeric.index;
  const tampered = emitted.slice(0, tamperAt) + String(Number(numeric[0]) + 1) + emitted.slice(tamperAt + numeric[0].length);
  assert.throws(() => execFileSync('lua5.4', ['-'], { input: tampered, encoding: 'utf8', timeout: 5000 }), /integridad comprometida/);
});
