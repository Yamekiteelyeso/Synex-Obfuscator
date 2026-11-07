import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '@synex/runtime';
import { obfuscate } from '../src/index.js';

/** Aplanado forzado (probabilidad 1) con varias semillas; la salida debe coincidir con el original. */
function flattenSame(src: string, expectFlattened = true) {
  const ref = execute(src);
  let flattened = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const out = obfuscate(src, {
      seed,
      renameIdentifiers: false,
      encodeStrings: false,
      controlFlowProbability: 1,
    });
    flattened += out.stats.flattenedBlocks;
    const got = execute(out.code);
    assert.deepEqual(got.output, ref.output, `semilla ${seed}`);
    assert.deepEqual(got.returned, ref.returned, `semilla ${seed}`);
  }
  if (expectFlattened) assert.ok(flattened > 0, 'debería aplanarse algún bloque');
}

test('función local recursiva dentro de un bucle se aplana', () => {
  flattenSame(`
    local total = 0
    for i = 1, 4 do
      local function fact(n)
        if n <= 1 then return 1 end
        return n * fact(n - 1)
      end
      local a = fact(i)
      local b = a + 1
      total = total + b
      local c = total % 7
      total = total + c
    end
    print(total)`);
});

test('break del bucle exterior dentro de un bloque aplanado', () => {
  flattenSame(`
    local out = {}
    for i = 1, 10 do
      local x = i * 2
      local y = x + 1
      if y > 9 then break end
      local z = y * 3
      out[#out + 1] = z
    end
    print(table.concat(out, ","))`);
});

test('continue del bucle exterior dentro de un bloque aplanado', () => {
  flattenSame(`
    local s = 0
    for i = 1, 8 do
      local a = i + 1
      local b = a * 2
      if b % 3 == 0 then continue end
      local c = b - i
      s = s + c
    end
    print(s)`);
});

test('una función que se llama antes de declarar su variable local no se aplana', () => {
  // La lectura previa de "helper" dentro de la función debe seguir apuntando al global.
  flattenSame(`
    helper = function() return 10 end
    local function use() return helper() end
    local a = use()
    local b = a + 1
    local c = b * 2
    local d = c - 1
    print(a, b, c, d)`, false);
});
