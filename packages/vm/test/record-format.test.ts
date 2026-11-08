import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileLuauRecordsV2, verifyLuauRecordsV2 } from '../src/record-format.js';

const masterEncryptionKey = Buffer.alloc(32, 0x4b);
const masterIntegrityKey = Buffer.alloc(32, 0x6d);
const instructions = [
  { opcode: 3, a: 20, b: 0, c: 0, nextPC: 2 },
  { opcode: 3, a: 22, b: 0, c: 0, nextPC: 0 },
];

describe('TypeScript modular Luau record compiler v2', () => {
  test('serializes fixed-width instructions into authenticated v2 records', () => {
    const artifact = compileLuauRecordsV2(instructions, {
      masterEncryptionKey,
      masterIntegrityKey,
      prototypeSalt: 99,
      nonces: [Buffer.alloc(24, 2), Buffer.alloc(24, 3)],
    });

    assert.equal(artifact.version, 2);
    assert.equal(artifact.records.length, 2);
    for (const record of artifact.records) {
      assert.equal(record.ciphertext.length, 20);
      assert.equal(record.tag.length, 16);
      assert.equal(record.nonce.length, 24);
      assert.equal(record.chainTag.length, 32);
    }
    assert.equal(verifyLuauRecordsV2(artifact, { masterIntegrityKey }), true);
  });

  test('detects tampering, truncation, and wrong integrity keys', () => {
    const artifact = compileLuauRecordsV2(instructions, {
      masterEncryptionKey,
      masterIntegrityKey,
      prototypeSalt: 99,
      nonces: [Buffer.alloc(24, 5), Buffer.alloc(24, 6)],
    });
    const altered = {
      ...artifact,
      records: artifact.records.map((record) => ({ ...record, ciphertext: Buffer.from(record.ciphertext) })),
    };
    altered.records[1]!.ciphertext[0] ^= 1;

    assert.equal(verifyLuauRecordsV2(altered, { masterIntegrityKey }), false);
    assert.equal(verifyLuauRecordsV2(artifact, { masterIntegrityKey: Buffer.alloc(32, 0x11) }), false);
    assert.equal(verifyLuauRecordsV2({ ...artifact, records: artifact.records.slice(0, 1) }, { masterIntegrityKey }), false);
  });

  test('rejects nonce reuse and malformed input', () => {
    assert.throws(() => compileLuauRecordsV2(instructions, {
      masterEncryptionKey,
      masterIntegrityKey,
      prototypeSalt: 99,
      nonces: [Buffer.alloc(24, 7), Buffer.alloc(24, 7)],
    }), /nonce reuse/);

    assert.throws(() => compileLuauRecordsV2(instructions, {
      masterEncryptionKey,
      masterIntegrityKey,
      prototypeSalt: 99,
      nonces: [Buffer.alloc(24, 7)],
    }), /one nonce/);

    assert.throws(() => compileLuauRecordsV2([{ opcode: 0x1_0000_0000 }], {
      masterEncryptionKey,
      masterIntegrityKey,
      prototypeSalt: 99,
      nonces: [Buffer.alloc(24, 8)],
    }), /unsigned 32-bit/);
  });
});
