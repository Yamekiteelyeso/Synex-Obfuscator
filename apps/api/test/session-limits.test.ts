import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/auth.js';

test('Sessions bounds persisted records and evicts the oldest session first', () => {
  let persisted: Array<{ token: string; userId: string; expiresAt: number }> = [];
  const persistence = {
    readSessions: () => persisted.slice(),
    writeSessions: (next: typeof persisted) => { persisted = next.slice(); },
  };
  const sessions = new Sessions(60_000, () => 1_000, persistence, 2);
  const first = sessions.create('first-user');
  const second = sessions.create('second-user');
  const third = sessions.create('third-user');

  assert.equal(sessions.userIdFor(first), null);
  assert.equal(sessions.userIdFor(second), 'second-user');
  assert.equal(sessions.userIdFor(third), 'third-user');
  assert.equal(persisted.length, 2);
});

test('Sessions periodically removes expired persisted records', () => {
  let now = 1_000;
  let persisted: Array<{ token: string; userId: string; expiresAt: number }> = [];
  const persistence = {
    readSessions: () => persisted.slice(),
    writeSessions: (next: typeof persisted) => { persisted = next.slice(); },
  };
  const sessions = new Sessions(1_000, () => now, persistence, 10);
  const token = sessions.create('expired-user');
  now += 61_000;

  assert.equal(sessions.userIdFor('missing-token'), null);
  assert.equal(sessions.userIdFor(token), null);
  assert.equal(persisted.length, 0);
});

test('Sessions rejects invalid capacity configuration', () => {
  assert.throws(() => new Sessions(60_000, () => 0, undefined, 0), /maxSessions/);
  assert.throws(() => new Sessions(60_000, () => 0, undefined, 1.5), /maxSessions/);
});
