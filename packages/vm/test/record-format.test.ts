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

import { compileLuauRecordsV3, verifyLuauRecordsV3 } from '../src/record-format.js';

describe('TypeScript modular Luau record compiler v3 (production nine-field shape)', () => {
  const fullInstructions = [
    { opcode: 17, a: 3, b: 4, target: 8, c: 1, line: 120045, nextPC: 5, checkA: 123456, checkB: 654321 },
    { opcode: 22, a: 0, b: 9, target: 0, c: 0, line: 120062, nextPC: 0, checkA: 222333, checkB: 333222 },
  ];

  test('encrypts all nine u32 fields (36 bytes) and verifies the chain', () => {
    const artifact = compileLuauRecordsV3(fullInstructions, {
      masterEncryptionKey, masterIntegrityKey, prototypeSalt: 123,
      nonces: [Buffer.alloc(24, 0x31), Buffer.alloc(24, 0x32)],
    });
    assert.equal(artifact.version, 3);
    assert.equal(artifact.records.length, 2);
    for (const record of artifact.records) {
      assert.equal(record.ciphertext.length, 36);
      assert.equal(record.tag.length, 16);
      assert.equal(record.nonce.length, 24);
      assert.equal(record.chainTag.length, 32);
    }
    assert.equal(verifyLuauRecordsV3(artifact, { masterIntegrityKey }), true);
  });

  test('rejects tampering, wrong keys, nonce reuse and values outside u32', () => {
    const options = {
      masterEncryptionKey, masterIntegrityKey, prototypeSalt: 123,
      nonces: [Buffer.alloc(24, 0x41), Buffer.alloc(24, 0x42)],
    };
    const artifact = compileLuauRecordsV3(fullInstructions, options);
    const altered = { ...artifact, records: artifact.records.map(record => ({
      ...record, ciphertext: Buffer.from(record.ciphertext),
    })) };
    altered.records[0]!.ciphertext[35] ^= 0x80;
    assert.equal(verifyLuauRecordsV3(altered, { masterIntegrityKey }), false);
    assert.equal(verifyLuauRecordsV3(artifact, { masterIntegrityKey: Buffer.alloc(32, 1) }), false);
    assert.throws(() => compileLuauRecordsV3(fullInstructions, {
      ...options, nonces: [Buffer.alloc(24, 7), Buffer.alloc(24, 7)],
    }), /nonce reuse/);
    assert.throws(() => compileLuauRecordsV3([{ ...fullInstructions[0]!, line: -1 }], {
      ...options, nonces: [Buffer.alloc(24, 8)],
    }), /unsigned 32-bit/);
  });
});
