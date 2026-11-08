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

test('select respeta índices positivos, negativos y validación Lua', () => {
  assert.deepEqual(out('local a, b = select(2, "a", "b", "c"); local c = select(-1, "a", "b", "c"); print(a, b, c, select("#", "a", "b", "c"))'), ['b\tc\tc\t3']);
  assert.throws(() => out('select(0, "a")'), /select.*index out of range/);
  assert.throws(() => out('select(1.5, "a")'), /select.*index out of range/);
  assert.throws(() => out('select(-3, "a", "b")'), /select.*index out of range/);
});

test('table.pack conserva nil y table.unpack devuelve múltiples valores', () => {
  const src = `
    local packed = table.pack("a", nil, "c")
    local first, middle, last = table.unpack(packed, 1, packed.n)
    print(packed.n, packed[1], packed[2], packed[3])
    print(first, middle, last)
  `;
  assert.deepEqual(out(src), ['3\ta\tnil\tc', 'a\tnil\tc']);
});

test('table.remove devuelve el elemento y desplaza la secuencia', () => {
  assert.deepEqual(out('local t = {"a", "b", "c"}; local removed = table.remove(t, 2); print(removed, #t, t[1], t[2])'), ['b\t2\ta\tc']);
  assert.deepEqual(out('local t = {1, 2}; print(table.remove(t, 9), #t)'), ['nil\t2']);
});

test('table.concat respeta separador e índices de inicio y fin', () => {
  assert.deepEqual(out('local t = {"a", "b", "c", "d"}; print(table.concat(t, "-", 2, 3))'), ['b-c']);
  assert.deepEqual(out('local t = {"a", "b"}; print(table.concat(t, ","))'), ['a,b']);
});

test('table.insert valida posiciones y conserva el orden', () => {
  assert.throws(() => out('local t = {}; table.insert(t, nil)'), /value expected/);
  assert.deepEqual(out('local t = {"a", "c"}; table.insert(t, 2, "b"); print(table.concat(t, ""))'), ['abc']);
  assert.throws(() => out('local t = {}; table.insert(t, 3, "x")'), /position out of bounds/);
});

test('string.sub y string.byte soportan índices negativos y rangos', () => {
  assert.deepEqual(out('print(string.sub("abcdef", 2, 4), string.sub("abcdef", -2), string.sub("abc", 8, 9))'), ['bcd	ef	']);
  assert.deepEqual(out('print(string.byte("abcd", 2, 3)); print(string.byte("abcd", -1)); print(string.byte("abcd", 2, 99)); print(string.byte("abcd", -99, 1))'), ['98\t99', '100', '98\t99\t100', '97']);
});

test('table.move maneja solapamiento y destino distinto', () => {
  assert.deepEqual(out('local t = {1, 2, 3, 4}; table.move(t, 1, 3, 2); print(table.concat(t, ","))'), ['1,1,2,3']);
  assert.deepEqual(out('local src = {"a", "b", "c"}; local dst = {}; local result = table.move(src, 1, 3, 2, dst); print(result == dst, table.concat(dst, ",", 2, 4))'), ['true\ta,b,c']);
  assert.throws(() => out('table.move({}, 1.5, 2, 1)'), /integer index/);
});

test('table.find devuelve el primer índice desde el inicio indicado', () => {
  assert.deepEqual(out('local t = {"a", "b", "a"}; print(table.find(t, "a"), table.find(t, "a", 2), table.find(t, "z"))'), ['1\t3\tnil']);
  assert.throws(() => out('table.find({}, 1, 1.5)'), /integer index/);
});

test('table.clone copia superficialmente y table.clear vacía', () => {
  assert.deepEqual(out('local t = {1, 2, x = 3}; local c = table.clone(t); c[1] = 9; print(t[1], c[1], c.x); table.clear(c); print(#c, c.x)'), ['1\t9\t3', '0\tnil']);
});

test('table.sort ordena números y acepta comparador Lua', () => {
  assert.deepEqual(out('local t = {4, 1, 3, 2}; table.sort(t); print(table.concat(t, ","))'), ['1,2,3,4']);
  assert.deepEqual(out('local t = {"a", "ccc", "bb"}; table.sort(t, function(a, b) return #a < #b end); print(table.concat(t, ","))'), ['a,bb,ccc']);
  assert.deepEqual(out('local t = {3, 1, 2}; table.sort(t, function(a, b) return a > b end); print(table.concat(t, ","))'), ['3,2,1']);
  assert.throws(() => out('local t = {1, "a"}; table.sort(t)'), /attempt to compare/);
});

test('table.create crea secuencias con valor inicial opcional', () => {
  assert.deepEqual(out('local a = table.create(3, "x"); local b = table.create(2); print(#a, a[1], a[3], #b, b[1])'), ['3\tx\tx\t0\tnil']);
  assert.throws(() => out('table.create(-1)'), /invalid size/);
});

test('biblioteca math cubre operaciones numéricas y clamp de Luau', () => {
  assert.deepEqual(out('print(math.abs(-4), math.floor(2.9), math.ceil(2.1), math.sqrt(81), math.max(1, 9, 3), math.min(1, 9, 3))'), ['4\t2\t3\t9\t9\t1']);
  assert.deepEqual(out('print(math.clamp(12, 0, 10), math.clamp(-2, 0, 10), math.sign(-3), math.round(2.5))'), ['10\t0\t-1\t3']);
  assert.deepEqual(out('local i, f = math.modf(-2.75); print(i, f, math.type(2), math.type(2.5), math.type(9007199254740992), math.tointeger(2.5))'), ['-2\t-0.75\tinteger\tfloat\tfloat\tnil']);
  assert.throws(() => out('math.clamp(1, 4, 2)'), /min must be <= max/);
});

test('math.randomseed hace reproducible math.random y valida intervalos', () => {
  const src = 'math.randomseed(123); local a = math.random(1, 10); local b = math.random(); math.randomseed(123); print(a, math.random(1, 10), b == math.random())';
  assert.deepEqual(out(src), ['' + (Number(out('math.randomseed(123); print(math.random(1, 10))')[0])) + '\t' + (Number(out('math.randomseed(123); print(math.random(1, 10))')[0])) + '\ttrue']);
  assert.throws(() => out('math.random(4, 2)'), /interval is empty/);
});

test('string.char valida bytes y string.split conserva campos vacíos', () => {
  assert.deepEqual(out('local t = string.split("a,,b,", ","); print(#t, t[1], t[2], t[3], t[4])'), ['4\ta\t\tb\t']);
  assert.throws(() => out('string.char(256)'), /out of range/);
  assert.throws(() => out('string.char(1.5)'), /out of range/);
});

test('string.find soporta búsqueda literal, índices negativos y modo plain explícito', () => {
  assert.deepEqual(out('print(string.find("hello hello", "hello"), string.find("hello hello", "hello", 2, true), string.find("hello", "z"))'), ['1\t5\t7\t11\tnil']);
  assert.deepEqual(out('print(string.find("abcdef", "cd", -4, true))'), ['3\t4']);
  assert.throws(() => out('string.find("abc", "a.c")'), /pattern matching is not implemented/);
});

test('string.format admite conversiones comunes, ancho y precisión', () => {
  assert.deepEqual(out('print(string.format("%04d %.2f %s %%", 7, 2.5, "ok"))'), ['0007 2.50 ok %']);
  assert.deepEqual(out('print(string.format("%#x %+d %.3g", 255, 8, 12.345))'), ['0xff +8 12.3']);
  assert.deepEqual(out('print(string.format("%q", "a\\nb"))'), ['"a\\\\nb"']);
  assert.throws(() => out('string.format("%d", 1.5)'), /integer expected/);
  assert.throws(() => out('string.format("%s", 1)'), /string expected/);
});

test('string.lower y upper conservan bytes no ASCII', () => {
  assert.deepEqual(out('print(string.lower("ABC-á"), string.upper("abc-á"))'), ['abc-Ã¡\tABC-Ã¡']);
});

test('string.lower, upper y reverse', () => {
  assert.deepEqual(out('print(string.lower("HeLLo"), string.upper("Synex"), string.reverse("abc"))'), ['hello\tSYNEX\tcba']);
});

test('string.rep repite con separador y valida límites', () => {
  assert.deepEqual(out('print(string.rep("ab", 3, "-"), string.rep("x", 0))'), ['ab-ab-ab	']);
  assert.throws(() => out('string.rep("x", -1)'), /invalid count/);
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


test('longitud de cadenas Unicode cuenta bytes UTF-8 como Lua', () => {
  assert.deepEqual(out('print(#"áé", #"漢字", #"🙂")'), ['4\t6\t4']);
});
