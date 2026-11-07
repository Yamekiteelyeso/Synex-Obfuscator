import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '@synex/runtime';
import { parse, printChunk } from '@synex/parser';
import { obfuscate } from '../src/index.js';
import { flattenControlFlow, collectIdentifiers } from '../src/flatten.js';
import { createRng } from '../src/random.js';

const PROGRAMS: Record<string, string> = {
  loop_body: `
    local total = 0
    for i = 1, 5 do
      local sq = i * i
      if sq % 2 == 0 then total = total + sq end
      total = total + 1
      local tag = "t" .. i
      total = total + #tag
    end
    print(total)`,
  early_return: `
    local function classify(n)
      local a = n * 2
      local b = a + 1
      if b > 10 then return "big" end
      local c = b - 1
      return c
    end
    print(classify(3), classify(9))`,
  varargs: `
    local function pack2(...)
      local n = select("#", ...)
      local first = ...
      local rest = n - 1
      local res = rest * 2
      return n, first, res
    end
    print(pack2(7, 8, 9))`,
  while_state: `
    local i, acc = 0, {}
    while i < 6 do
      i = i + 1
      local v = i * 10
      local w = v + i
      if w % 3 == 0 then acc[#acc + 1] = w end
      local n = #acc
      print(i, n)
    end
    print(table.concat(acc, ","))`,
  break_guard: `
    local found = 0
    for i = 1, 10 do
      local x = i * 3
      local y = x + 1
      if y == 16 then found = i break end
      local z = y - x
      found = found + z
    end
    print(found)`,
  read_before_decl: `
    local v = 5
    do
      local w = v + 1
      local v = w * 2
      local u = v + 1
      local k = u - 1
      print(w, v, u, k)
    end
    print(v)`,
  closures_skipped: `
    local fns = {}
    for i = 1, 3 do
      local a = i + 1
      local b = a * 2
      fns[i] = function() return a + b end
      local c = b - 1
      fns[i] = fns[i]
    end
    print(fns[1](), fns[2](), fns[3]())`,
};

function run(src: string) {
  const r = execute(src, { stepLimit: 2_000_000 });
  return JSON.stringify({ output: r.output, returned: r.returned });
}

for (const [name, src] of Object.entries(PROGRAMS)) {
  test(`aplanado conserva la salida: ${name}`, () => {
    const expected = run(src);
    for (let seed = 1; seed <= 4; seed++) {
      for (const rename of [true, false]) {
        const out = obfuscate(src, { seed, renameIdentifiers: rename, controlFlowProbability: 1, encodeStrings: seed % 2 === 0 });
        assert.equal(run(out.code), expected, `seed=${seed} rename=${rename}\n${out.code}`);
      }
    }
  });
}

test('el aplanado se aplica a bloques admisibles', () => {
  for (const name of ['loop_body', 'early_return', 'varargs', 'while_state']) {
    const out = obfuscate(PROGRAMS[name], { seed: 3, renameIdentifiers: false, encodeStrings: false, controlFlowProbability: 1 });
    assert.ok(out.stats.flattenedBlocks > 0, `${name} debería aplanarse`);
    assert.match(out.code, /while true do/);
  }
});

test('el aplanado omite bloques con break o con lecturas previas a la declaración', () => {
  const brk = obfuscate(PROGRAMS.break_guard, { seed: 1, renameIdentifiers: false, encodeStrings: false, controlFlowProbability: 1 });
  // El bloque del for contiene un break directo: no debe aplanarse ese bloque.
  assert.doesNotMatch(brk.code, /local [A-Za-z_]+ = 1\n\s*while true do\n\s*if [^\n]* == 11/);
  const shadow = obfuscate(PROGRAMS.read_before_decl, { seed: 1, renameIdentifiers: false, encodeStrings: false, controlFlowProbability: 1 });
  assert.equal(shadow.stats.flattenedBlocks, 0);
});

test('la probabilidad 0 no modifica el código', () => {
  const plain = obfuscate(PROGRAMS.loop_body, { seed: 2, renameIdentifiers: false, encodeStrings: false });
  const off = obfuscate(PROGRAMS.loop_body, { seed: 2, renameIdentifiers: false, encodeStrings: false, controlFlowProbability: 0 });
  assert.equal(off.code, plain.code);
  assert.equal(off.stats.flattenedBlocks, 0);
});

test('flattenControlFlow no revisita los bloques generados', () => {
  const chunk = parse(PROGRAMS.loop_body);
  let n = 0;
  const fresh = () => `Gen${n++}`;
  const count = flattenControlFlow(chunk, createRng(9), 1, fresh);
  assert.ok(count >= 1);
  // Reimprimir y reparsear: la salida debe seguir siendo Luau válido.
  assert.doesNotThrow(() => parse(printChunk(chunk)));
  assert.ok(collectIdentifiers(chunk).has('total'));
});
