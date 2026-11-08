import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileToLuauVm } from '../src/index.js';
import { lua54Available, runLua54 } from '../../../tools/lua54/lua54.js';

/**
 * Cross-seed regression coverage for the production 9-field emitter.
 * The cryptographic Luau substrate is intentionally not wired into this
 * emitter yet; these tests protect the existing runtime while that adapter
 * is developed independently.
 */
const CASES: Record<string, string> = {
  arithmetic_and_branches: `
    local function calc(n)
      local total = 0
      for i = 1, n do
        if i % 2 == 0 then total = total + i * 3
        else total = total - i end
      end
      return total
    end
    print(calc(17), calc(0))
  `,
  closures_and_upvalues: `
    local function makePair()
      local value = 4
      return function(delta) value = value + delta; return value end,
             function() return value end
    end
    local add, read = makePair()
    add(3); add(8)
    print(read(), add(-2))
  `,
  multiple_returns_and_varargs: `
    local function values(...)
      return select("#", ...), ...
    end
    local count, a, b, c = values("x", nil, 9)
    print(count, a, b, c)
    print(values())
  `,
  tables_and_methods: `
    local object = {value = 6}
    function object:scale(n) self.value = self.value * n; return self.value end
    local list = {2, 3, 5}
    list[#list + 1] = object:scale(7)
    print(table.concat(list, ","), object.value)
  `,
  loop_control: `
    local total = 0
    for i = 1, 30 do
      if i % 7 == 0 then
        total = total + i
      elseif i % 5 == 0 then
        total = total - i
      end
    end
    local n = 0
    repeat n = n + 1 until n == 4
    print(total, n)
  `,
};

const SEEDS = [0, 1, 2, 7, 0x12345678, 0x7fffffff, 0xffffffff];

describe('VM Luau emitter: cross-seed semantic regression', { skip: !lua54Available && 'falta tools/lua54/lua54run' }, () => {
  for (const [name, source] of Object.entries(CASES)) {
    test(name, () => {
      const original = runLua54(source);
      assert.ok(original.ok, `original: ${original.error}`);

      for (const seed of SEEDS) {
        const output = compileToLuauVm(source, seed);
        const emitted = runLua54(output);
        assert.ok(emitted.ok, `seed ${seed}: ${emitted.error}`);
        assert.equal(emitted.stdout, original.stdout, `semantic mismatch at seed ${seed}`);
      }
    });
  }
});
