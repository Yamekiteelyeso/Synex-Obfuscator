import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@synex/parser';
import { analyze } from '@synex/semantic';
import { compile, type Proto } from '@synex/ir';
import { compileToLuauVm, validateProto, VM } from '../src/index.js';
import { lua54Available, runLua54 } from '../../../tools/lua54/lua54.js';

function protoOf(src: string): Proto {
  const chunk = parse(src);
  return compile(chunk, analyze(chunk));
}

describe('validación del bytecode', () => {
  test('un programa compilado es válido', () => {
    assert.doesNotThrow(() => validateProto(protoOf('local a = 1 print(a + 2)')));
  });

  test('rechaza un salto fuera del código', () => {
    const p = protoOf('local a = 1 if a then print(a) end');
    const jump = p.code.find((i) => i.op === 'JF' || i.op === 'JMP');
    assert.ok(jump, 'hay un salto');
    jump!.t = p.code.length + 5;
    assert.throws(() => validateProto(p), /salto fuera del código/);
  });

  test('rechaza una constante fuera de rango', () => {
    const p = protoOf('print("hola")');
    const c = p.code.find((i) => i.op === 'CONST')!;
    c.a = 999;
    assert.throws(() => validateProto(p), /constante fuera de rango/);
  });

  test('limita el total de constantes acumuladas entre prototipos', () => {
    const p = protoOf('return 1');
    const child = protoOf('return 2');
    p.protos = [child];
    p.consts = Array(500_001).fill(null);
    child.consts = Array(500_001).fill(null);
    assert.throws(() => validateProto(p), /cantidad total de constantes excedida/);
  });


  test('rechaza operandos ausentes o no enteros en todas las familias', () => {
    const p = protoOf('local x = 1 print(x)');
    const local = p.code.find((i) => i.op === 'GETL')!;
    local.a = 0.5;
    assert.throws(() => validateProto(p), /operando a no es un entero seguro|ranura fuera de rango/);
  });

  test('rechaza nombres globales que no sean constantes de cadena', () => {
    const p = protoOf('print(1)');
    const global = p.code.find((i) => i.op === 'GETG')!;
    p.consts[global.a!] = 123;
    assert.throws(() => validateProto(p), /nombre global\/método no es una cadena/);
  });

  test('rechaza banderas y descriptores CALL inconsistentes', () => {
    const p = protoOf('print(1)');
    const call = p.code.find((i) => i.op === 'CALL')!;
    call.b = -2;
    assert.throws(() => validateProto(p), /descriptor CALL inválido/);
  });

  test('rechaza prototipos cíclicos', () => {
    const p = protoOf('local function f() return 1 end');
    p.protos.push(p);
    assert.throws(() => validateProto(p), /ciclo en árbol de prototipos/);
  });

  test('valida correctamente closures con upvalues al ejecutarlos', () => {
    const p = protoOf('local x = 7 local function f() return x end print(f())');
    const vm = new VM();
    assert.doesNotThrow(() => vm.execute(p));
    assert.deepEqual(vm.output, ['7']);
  });

  test('la VM pública rechaza bytecode manipulado antes de ejecutarlo', () => {
    const p = protoOf('print(1)');
    p.code[0].op = 'UNKNOWN' as any;
    assert.throws(() => new VM().execute(p), /operación desconocida/);
  });

  test('rechaza una operación desconocida', () => {
    const p = protoOf('print(1)');
    p.code[0].op = 'NOPE' as any;
    assert.throws(() => validateProto(p), /operación desconocida/);
  });

});

describe('VM emitida: límites y diagnóstico', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  test('el límite de pasos aborta un bucle infinito con número de línea', () => {
    const src = 'local x = 0\nwhile true do\n  x = x + 1\nend';
    const out = compileToLuauVm(src, 3, { stepLimit: 5000 });
    const r = runLua54(out);
    assert.equal(r.ok, false);
    assert.match(r.error, /límite de ejecución superado/);
    assert.match(r.error, /línea \d+/);
  });

  test('un error de ejecución lleva la línea donde ocurre', () => {
    const src = 'local a = 1\nlocal b = nil\nprint(b())';
    const r = runLua54(compileToLuauVm(src, 3));
    assert.equal(r.ok, false);
    assert.match(r.error, /línea 3/);
  });

  test('un programa dentro del límite se ejecuta igual que el original', () => {
    const src = 'local s = 0\nfor i = 1, 100 do s = s + i end\nprint(s)';
    const orig = runLua54(src);
    const got = runLua54(compileToLuauVm(src, 3, { stepLimit: 100_000 }));
    assert.ok(got.ok, got.error);
    assert.equal(got.stdout, orig.stdout);
  });

  test('un límite de pasos no válido se rechaza', () => {
    assert.throws(() => compileToLuauVm('print(1)', 1, { stepLimit: 0 }), /límite de pasos inválido/);
  });
});


describe('polimorfismo del pool de constantes', () => {
  test('la permutación es determinista para una semilla y varía entre builds', () => {
    const source = [
      'local alpha = "ALPHA_MARKER"',
      'local beta = "BETA_MARKER"',
      'local gamma = "GAMMA_MARKER"',
      'print(alpha, beta, gamma)',
    ].join('\n');
    const a = compileToLuauVm(source, 123456);
    const same = compileToLuauVm(source, 123456);
    const other = compileToLuauVm(source, 123457);
    assert.equal(a, same);
    assert.notEqual(a, other);
  });

  test('el pool permutado conserva referencias globales y constantes', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
    const source = [
      'local alpha = "ALPHA_MARKER"',
      'local beta = "BETA_MARKER"',
      'local gamma = "GAMMA_MARKER"',
      'local function join(a, b) return a .. b end',
      'print(join(alpha, beta), gamma, math.floor(9.8))',
    ].join('\n');
    const original = runLua54(source);
    const emitted = runLua54(compileToLuauVm(source, 884422));
    assert.ok(emitted.ok, emitted.error);
    assert.equal(emitted.stdout, original.stdout);
  });
});


describe('sellos jerárquicos de prototipos', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  test('closures anidadas conservan la relación padre-hijo al ejecutarse', () => {
    const source = [
      'local seed = 40',
      'local function outer(delta)',
      '  local captured = seed + delta',
      '  return function(extra)',
      '    return function() return captured + extra end',
      '  end',
      'end',
      'local middle = outer(2)',
      'local inner = middle(3)',
      'print(inner())',
    ].join('\n');
    const original = runLua54(source);
    const emitted = runLua54(compileToLuauVm(source, 441122));
    assert.ok(emitted.ok, emitted.error);
    assert.equal(emitted.stdout, original.stdout);
    assert.equal(emitted.stdout.trim(), '45');
  });

  test('cada compilación produce una jerarquía reproducible y distinta por semilla', () => {
    const source = 'local function outer() return function() return 9 end end print(outer()())';
    const a = compileToLuauVm(source, 7001);
    const same = compileToLuauVm(source, 7001);
    const other = compileToLuauVm(source, 7002);
    assert.equal(a, same);
    assert.notEqual(a, other);
  });
});

describe('constantes lazy de nil y boolean', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  test('preserva nil, true y false incluso tras múltiples lecturas', () => {
    const source = [
      'local absent = nil',
      'local yes = true',
      'local no = false',
      'print(absent == nil, yes, no)',
      'print(absent == nil, yes == true, no == false)',
    ].join('\n');
    const original = runLua54(source);
    const emitted = runLua54(compileToLuauVm(source, 913579));
    assert.ok(emitted.ok, emitted.error);
    assert.equal(emitted.stdout, original.stdout);
  });
});

describe('codec polimórfico de constantes', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  test('decodifica cadenas UTF-8 y números con parámetros variables', () => {
    const source = [
      'local text = "áé漢字🙂 — Synex"',
      'local negative = -123.5',
      'local fraction = 0.125',
      'local integer = 98765',
      'print(text)',
      'print(negative, fraction, integer)',
    ].join('\n');
    const original = runLua54(source);
    for (const seed of [17, 987654, 0x7fffffff]) {
      const emitted = runLua54(compileToLuauVm(source, seed));
      assert.ok(emitted.ok, emitted.error);
      assert.equal(emitted.stdout, original.stdout);
    }
  });
});
