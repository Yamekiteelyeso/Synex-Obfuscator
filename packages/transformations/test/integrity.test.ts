import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { obfuscate, createStringEncoder, createRng } from '../src/index.js';
import { lua54Available, runLua54 } from '../../../tools/lua54/lua54.js';

const SRC = `
local greeting = "hola mundo"
local parts = {"uno", "dos", "tres"}
print(greeting, #parts, parts[2])
`;

describe('comprobación de integridad en tiempo de ejecución', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  test('el código íntegro se ejecuta igual que el original', () => {
    const out = obfuscate(SRC, { seed: 3, encodeStrings: true, integrity: true });
    const orig = runLua54(SRC);
    const got = runLua54(out.code);
    assert.ok(orig.ok && got.ok, got.error);
    assert.equal(got.stdout, orig.stdout);
  });

  test('una tabla de datos alterada se detecta al cargar', () => {
    const out = obfuscate(SRC, { seed: 3, encodeStrings: true, integrity: true });
    // Cambia un byte cifrado dentro de la primera entrada de la tabla E.
    const tampered = out.code.replace(/local (\w+)=\{\{(\d+)/, (_m, name, first) =>
      `local ${name}={{${(Number(first) + 1) % 256}`);
    assert.notEqual(tampered, out.code);
    const got = runLua54(tampered);
    assert.equal(got.ok, false);
    assert.match(got.error, /integridad comprometida/);
  });

  test('la comprobación sin cadenas no es posible: el encoder se exige', () => {
    assert.throws(() => obfuscate(SRC, { encodeStrings: false, integrity: true }), /integridad necesita/);
  });

  test('la cabecera sin verificación no contiene la comprobación', () => {
    const enc = createStringEncoder({ table: 'T', keys: 'K', cache: 'C', decode: 'D' }, createRng(1));
    enc.encode('x');
    assert.doesNotMatch(enc.header(false), /integridad/);
    assert.match(enc.header(true), /integridad comprometida/);
  });
});
