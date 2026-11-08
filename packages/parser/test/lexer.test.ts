import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/index.js';

const values = (src: string) =>
  tokenize(src).filter((t) => t.type !== 'EOF').map((t) => `${t.type}:${t.value}`);

test('identificadores y palabras clave', () => {
  assert.deepEqual(values('local x = nil'), ['Keyword:local', 'Name:x', 'Operator:=', 'Keyword:nil']);
});

test('palabras clave propias de Luau', () => {
  assert.deepEqual(values('continue type export'), ['Keyword:continue', 'Keyword:type', 'Keyword:export']);
});

test('operadores compuestos de Luau', () => {
  assert.deepEqual(values('a += 1 b //= 2 c ..= d'), [
    'Name:a', 'Operator:+=', 'Number:1',
    'Name:b', 'Operator://=', 'Number:2',
    'Name:c', 'Operator:..=', 'Name:d',
  ]);
});

test('números: decimal, exponente, hex, binario y separadores', () => {
  assert.deepEqual(values('1 2.5 3e-2 0xFF 0b1010 1_000'), [
    'Number:1', 'Number:2.5', 'Number:3e-2', 'Number:0xFF', 'Number:0b1010', 'Number:1_000',
  ]);
});

test('cadenas con escapes decodificados', () => {
  const [t] = tokenize('"a\\n\\65\\x42\\u{43}"');
  assert.equal(t.type, 'String');
  assert.equal(t.value, 'a\nABC');
});

test('\\z salta espacios incluidos saltos de línea', () => {
  const [t] = tokenize('"a\\z   \n  b"');
  assert.equal(t.value, 'ab');
});

test('corchetes largos con nivel', () => {
  const [t] = tokenize('[==[ x ]] y ]==]');
  assert.equal(t.type, 'String');
  assert.equal(t.value, ' x ]] y ');
});

test('comentarios de línea y de bloque se descartan', () => {
  assert.deepEqual(values('a -- nota\nb --[[ bloque\n]] c --[==[ x ]==] d'), [
    'Name:a', 'Name:b', 'Name:c', 'Name:d',
  ]);
});

test('posiciones de línea y columna', () => {
  const toks = tokenize('local a\n  b');
  assert.deepEqual([toks[1].line, toks[1].column], [1, 7]);
  assert.deepEqual([toks[2].line, toks[2].column], [2, 3]);
});

test('"..." y ".." se distinguen de números con punto', () => {
  assert.deepEqual(values('... .. .5'), ['Operator:...', 'Operator:..', 'Number:.5']);
});

test('cadena sin cerrar produce error con posición', () => {
  assert.throws(() => tokenize('x = "abc\n'), (e: any) => e.code === 'E_UNFINISHED_STRING' && e.line === 1);
});

test('corchete largo sin cerrar produce error', () => {
  assert.throws(() => tokenize('[[ abc'), (e: any) => e.code === 'E_UNFINISHED_LONG');
});

test('escapes Unicode fuera del rango escalar producen error léxico', () => {
  for (const source of ['"\\u{110000}"', '"\\u{D800}"', '"\\u{FFFFFFFF}"']) {
    assert.throws(
      () => tokenize(source),
      (error: any) => error.code === 'E_BAD_ESCAPE',
    );
  }
});

test('escape inválido produce error', () => {
  assert.throws(() => tokenize('"\\q"'), (e: any) => e.code === 'E_BAD_ESCAPE');
});

test('carácter no válido produce error', () => {
  assert.throws(() => tokenize('a $ b'), (e: any) => e.code === 'E_BAD_CHAR');
});

test('número mal formado produce error', () => {
  assert.throws(() => tokenize('12abc'), (e: any) => e.code === 'E_BAD_NUMBER');
});
