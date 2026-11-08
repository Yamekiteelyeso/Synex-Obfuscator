import { createCipheriv, createDecipheriv } from 'node:crypto';

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;
const MASK32 = 0xffff_ffff;

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function writeU32LE(value: number, out: Buffer, offset: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: number[], a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft(state[d]! ^ state[a]!, 16);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft(state[b]! ^ state[c]!, 12);
  state[a] = (state[a]! + state[b]!) >>> 0;
  state[d] = rotateLeft(state[d]! ^ state[a]!, 8);
  state[c] = (state[c]! + state[d]!) >>> 0;
  state[b] = rotateLeft(state[b]! ^ state[c]!, 7);
}

function hchacha20(key: Uint8Array, nonce16: Uint8Array): Buffer {
  if (key.byteLength !== 32 || nonce16.byteLength !== 16) {
    throw new RangeError('HChaCha20 requires a 32-byte key and 16-byte nonce');
  }
  const state = [
    ...SIGMA,
    ...Array.from({ length: 8 }, (_, i) => readU32LE(key, i * 4)),
    ...Array.from({ length: 4 }, (_, i) => readU32LE(nonce16, i * 4)),
  ];

  for (let i = 0; i < 10; i++) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }

  const out = Buffer.allocUnsafe(32);
  [state[0]!, state[1]!, state[2]!, state[3]!,
    state[12]!, state[13]!, state[14]!, state[15]!]
    .forEach((word, i) => writeU32LE(word, out, i * 4));
  return out;
}

function xchachaSubkeyAndNonce(key: Uint8Array, nonce24: Uint8Array): {
  subkey: Buffer;
  nonce12: Buffer;
} {
  if (key.byteLength !== 32) throw new RangeError('XChaCha20-Poly1305 key must be 32 bytes');
  if (nonce24.byteLength !== 24) throw new RangeError('XChaCha20-Poly1305 nonce must be 24 bytes');
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = Buffer.alloc(12);
  Buffer.from(nonce24.subarray(16, 24)).copy(nonce12, 4);
  return { subkey, nonce12 };
}

/**
 * Encrypts with XChaCha20-Poly1305 (IETF AEAD construction).
 * Callers must never reuse a nonce with the same key.
 */
export function sealXChaCha20Poly1305(
  key: Uint8Array,
  nonce24: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = Buffer.alloc(0),
): { ciphertext: Buffer; tag: Buffer } {
  const { subkey, nonce12 } = xchachaSubkeyAndNonce(key, nonce24);
  const cipher = createCipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

/**
 * Authenticates before returning plaintext. Returns null for any tag/AAD mismatch.
 */
export function openXChaCha20Poly1305(
  key: Uint8Array,
  nonce24: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = Buffer.alloc(0),
): Buffer | null {
  if (tag.byteLength !== 16) return null;
  const { subkey, nonce12 } = xchachaSubkeyAndNonce(key, nonce24);
  try {
    const decipher = createDecipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad), { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}
