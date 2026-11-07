import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@synex/parser';
import { runProfile } from '../src/index.js';
import { lua54Available, runLua54 } from '../../../tools/lua54/lua54.js';

/**
 * Equivalencia en Lua 5.4 real del resultado del motor. Los programas evitan
 * "continue" (sólo existe en Luau) y las funciones de Luau que Lua 5.4 no tiene.
 */
const PROGRAMS: Record<string, string> = {
  totals: `
    local total = 0
    for i = 1, 6 do
      local sq = i * i
      if sq % 2 == 0 then total = total + sq end
      total = total + 1
      local tag = "t" .. i
      total = total + #tag
    end
    print(total)`,
  classify: `
    local function classify(n)
      local a = n * 2
      local b = a + 1
      if b > 10 then return "big" end
      local c = b - 1
      return c
    end
    print(classify(3), classify(9), "ok" == "ok")`,
  recursion_in_loop: `
    local acc = {}
    for i = 1, 4 do
      local function fact(n)
        if n <= 1 then return 1 end
        return n * fact(n - 1)
      end
      local a = fact(i)
      local b = a + 1
      acc[#acc + 1] = b
    end
    print(table.concat(acc, ","))`,
  break_in_loop: `
    local out = {}
    for i = 1, 10 do
      local x = i * 2
      local y = x + 1
      if y > 9 then break end
      out[#out + 1] = y * 3
    end
    print(table.concat(out, ","))`,
};

describe('motor: resultado en Lua 5.4 real', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    for (const profile of ['professional', 'advanced', 'basic'] as const) {
      test(`${name} con perfil ${profile}`, () => {
        const orig = runLua54(src);
        assert.ok(orig.ok, orig.error);
        const r = runProfile(src, { profile, seed: 11 });
        const got = runLua54(r.code);
        assert.ok(got.ok, `ofuscado: ${got.error}`);
        assert.equal(got.stdout, orig.stdout);
      });
    }
  }

  test('perfil personalizado con VM ejecuta igual en Lua 5.4', () => {
    const src = PROGRAMS.totals;
    const orig = runLua54(src);
    const r = runProfile(src, { profile: 'custom', custom: { techniques: ['vm'] }, seed: 4 });
    assert.doesNotThrow(() => parse(r.code));
    assert.ok(r.techniques.includes('vm'));
    const got = runLua54(r.code);
    assert.ok(got.ok, got.error);
    assert.equal(got.stdout, orig.stdout);
    assert.equal(r.equivalence.status, 'skipped');
  });
});

describe('perfiles NORMAL / MEDIUM / MAX en Lua 5.4 real', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  for (const profile of ['normal', 'medium', 'max'] as const) {
    test(`perfil ${profile} conserva el comportamiento`, () => {
      const src = PROGRAMS.break_in_loop + '\n' + PROGRAMS.classify;
      const orig = runLua54(src);
      assert.ok(orig.ok, orig.error);
      const r = runProfile(src, { profile, seed: 21 });
      const got = runLua54(r.code);
      assert.ok(got.ok, `ofuscado: ${got.error}`);
      assert.equal(got.stdout, orig.stdout);
    });
  }

  test('MAX incluye la VM y NORMAL no', () => {
    const max = runProfile('print(1)', { profile: 'max', seed: 1 });
    const normal = runProfile('print(1)', { profile: 'normal', seed: 1 });
    assert.ok(max.techniques.includes('vm'));
    assert.ok(!normal.techniques.includes('vm'));
    assert.ok(normal.code.length < max.code.length);
  });
});
