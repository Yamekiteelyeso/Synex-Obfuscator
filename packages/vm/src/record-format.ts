import { createHmac } from 'node:crypto';
import { sealXChaCha20Poly1305 } from './xchacha.js';

const U32_MAX = 0xffff_ffff;
export interface LuauInstructionV2 {
  opcode: number;
  a?: number;
  b?: number;
  c?: number;
  nextPC?: number;
}

export interface RecordV2 {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  chainTag: Buffer;
  aad: Buffer;
}

export interface ArtifactV2 {
  version: 2;
  prototypeSalt: number;
  records: RecordV2[];
  finalChain: Buffer;
}

export interface CompileRecordV2Options {
  masterEncryptionKey: Uint8Array;
  masterIntegrityKey: Uint8Array;
  prototypeSalt: number;
  nonces: readonly Uint8Array[];
  aadPrefix?: string;
}

function u32le(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError('instruction fields must be unsigned 32-bit integers');
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function frame(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32le(bytes.length), bytes]);
}

function hmac(key: Uint8Array, message: Uint8Array): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

function deriveKeys(
  masterEncryptionKey: Uint8Array,
  masterIntegrityKey: Uint8Array,
  prototypeSalt: number,
): { encryptionKey: Buffer; integrityKey: Buffer } {
  if (masterEncryptionKey.byteLength !== 32) throw new RangeError('master encryption key must be 32 bytes');
  if (masterIntegrityKey.byteLength < 16) throw new RangeError('master integrity key must be at least 16 bytes');
  if (!Number.isSafeInteger(prototypeSalt) || prototypeSalt < 0 || prototypeSalt > U32_MAX) throw new RangeError('prototype salt must be an unsigned 32-bit integer');
  const context = Buffer.from(String(Math.floor(prototypeSalt)));
  return {
    encryptionKey: hmac(masterEncryptionKey, Buffer.concat([Buffer.from('Synex/prototype-encryption/v1:'), context])),
    integrityKey: hmac(masterIntegrityKey, Buffer.concat([Buffer.from('Synex/prototype-integrity/v1:'), context])),
  };
}

function encodeInstruction(instruction: LuauInstructionV2): Buffer {
  return Buffer.concat([
    u32le(instruction.opcode),
    u32le(instruction.a ?? 0),
    u32le(instruction.b ?? 0),
    u32le(instruction.c ?? 0),
    u32le(instruction.nextPC ?? 0),
  ]);
}

function startChain(integrityKey: Uint8Array, prototypeSalt: number): Buffer {
  return hmac(integrityKey, Buffer.concat([
    Buffer.from('Synex/VM/record-chain-start\0'),
    u32le(prototypeSalt >>> 0),
  ]));
}

function advanceChain(
  integrityKey: Uint8Array,
  previous: Uint8Array,
  pc: number,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Buffer {
  return hmac(integrityKey, Buffer.concat([
    Buffer.from('Synex/VM/record-chain\0'),
    Buffer.from(previous),
    u32le(pc),
    frame(nonce),
    frame(aad),
    frame(ciphertext),
    frame(tag),
  ]));
}

/**
 * Builds the modular Luau VM v2 record container. Nonces must come from a
 * cryptographically secure source and must never repeat under the derived key.
 * This serializer is not yet wired into the production emit.ts pipeline.
 */
export function compileLuauRecordsV2(
  instructions: readonly LuauInstructionV2[],
  options: CompileRecordV2Options,
): ArtifactV2 {
  if (instructions.length === 0) throw new RangeError('at least one instruction is required');
  if (options.nonces.length !== instructions.length) throw new RangeError('one nonce is required per instruction');
  const salt = options.prototypeSalt;
  const { encryptionKey, integrityKey } = deriveKeys(
    options.masterEncryptionKey, options.masterIntegrityKey, salt,
  );
  const seenNonces = new Set<string>();
  let chain = startChain(integrityKey, salt);
  const records: RecordV2[] = [];

  instructions.forEach((instruction, index) => {
    const nonce = Buffer.from(options.nonces[index]!);
    if (nonce.length !== 24) throw new RangeError('each nonce must be 24 bytes');
    const nonceKey = nonce.toString('hex');
    if (seenNonces.has(nonceKey)) throw new Error('nonce reuse within a prototype is forbidden');
    seenNonces.add(nonceKey);

    const aad = Buffer.from(
      `${options.aadPrefix ?? 'synex:v1'}:${Math.floor(salt)}:${index + 1}`,
    );
    const { ciphertext, tag } = sealXChaCha20Poly1305(
      encryptionKey, nonce, encodeInstruction(instruction), aad,
    );
    const chainTag = advanceChain(
      integrityKey, chain, index + 1, nonce, aad, ciphertext, tag,
    );
    records.push({ nonce, ciphertext, tag, chainTag, aad });
    chain = chainTag;
  });

  return { version: 2, prototypeSalt: salt, records, finalChain: chain };
}

/** Checks the static HMAC chain without decrypting any instruction. */
export function verifyLuauRecordsV2(artifact: ArtifactV2, options: Pick<
  CompileRecordV2Options, 'masterIntegrityKey'
>): boolean {
  if (artifact.version !== 2 || artifact.records.length === 0) return false;
  let chain: Buffer;
  try {
    if (options.masterIntegrityKey.byteLength < 16) return false;
    const integrityKey = hmac(
      options.masterIntegrityKey,
      Buffer.concat([
        Buffer.from('Synex/prototype-integrity/v1:'),
        Buffer.from(String(Math.floor(artifact.prototypeSalt))),
      ]),
    );
    chain = startChain(integrityKey, artifact.prototypeSalt);
    for (let index = 0; index < artifact.records.length; index++) {
      const record = artifact.records[index]!;
      const expected = advanceChain(
        integrityKey, chain, index + 1, record.nonce, record.aad,
        record.ciphertext, record.tag,
      );
      if (!expected.equals(record.chainTag)) return false;
      chain = expected;
    }
  } catch {
    return false;
  }
  return chain.equals(artifact.finalChain);
}

