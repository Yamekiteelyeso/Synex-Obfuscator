import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneBoundedMap } from '../src/limits.js';

test('pruneBoundedMap removes expired entries before making FIFO room', () => {
  const entries = new Map<string, { expiresAt: number }>([
    ['expired', { expiresAt: 10 }],
    ['oldest', { expiresAt: 100 }],
    ['newer', { expiresAt: 100 }],
    ['newest', { expiresAt: 100 }],
  ]);

  pruneBoundedMap(entries, 10, 3, (entry) => entry.expiresAt, 1);
  assert.deepEqual([...entries.keys()], ['newer', 'newest']);
  entries.set('inserted', { expiresAt: 100 });
  assert.equal(entries.size, 3);
});

test('pruneBoundedMap preserves every unexpired entry below the capacity', () => {
  const entries = new Map<string, { expiresAt: number }>([
    ['first', { expiresAt: 50 }],
    ['second', { expiresAt: 60 }],
  ]);

  pruneBoundedMap(entries, 10, 3, (entry) => entry.expiresAt, 1);
  assert.deepEqual([...entries.keys()], ['first', 'second']);
});

test('pruneBoundedMap rejects invalid capacity settings', () => {
  assert.throws(() => pruneBoundedMap(new Map(), 0, 0, () => 1), /invalid bounded map capacity/);
  assert.throws(() => pruneBoundedMap(new Map(), 0, 2, () => 1, 2), /invalid bounded map capacity/);
});

test('pruneBoundedMap can evict an undefined map key', () => {
  const entries = new Map< string | undefined, { expiresAt: number }>([
    [undefined, { expiresAt: 100 }],
    ['retained', { expiresAt: 100 }],
  ]);
  pruneBoundedMap(entries, 10, 2, (entry) => entry.expiresAt, 1);
  assert.deepEqual([...entries.keys()], ['retained']);
});
