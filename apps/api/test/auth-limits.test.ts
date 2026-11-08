import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter } from '../src/auth.js';

test('LoginLimiter bounds distinct email keys and evicts FIFO at capacity', () => {
  let now = 1_000;
  const limiter = new LoginLimiter(2, 60_000, () => now, 2);
  limiter.fail('first@example.test');
  limiter.fail('second@example.test');
  limiter.fail('third@example.test');

  assert.equal(limiter.blocked('first@example.test'), false);
  limiter.fail('third@example.test');
  limiter.fail('third@example.test');
  assert.equal(limiter.blocked('third@example.test'), true);
  assert.equal(limiter.blocked('second@example.test'), false);
});

test('LoginLimiter prunes expired entries before inserting new keys', () => {
  let now = 1_000;
  const limiter = new LoginLimiter(1, 100, () => now, 2);
  limiter.fail('expired@example.test');
  now += 101;
  limiter.fail('active@example.test');
  assert.equal(limiter.blocked('expired@example.test'), false);
  assert.equal(limiter.blocked('active@example.test'), true);
});

test('LoginLimiter rejects invalid storage limits', () => {
  assert.throws(() => new LoginLimiter(5, 100, () => 0, 0), /positive safe integers/);
});
