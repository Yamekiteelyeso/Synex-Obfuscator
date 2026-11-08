import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openXChaCha20Poly1305, sealXChaCha20Poly1305 } from '../src/xchacha.js';

const fromHex = (value: string) => Buffer.from(value, 'hex');

describe('TypeScript XChaCha20-Poly1305', () => {
  test('matches the libsodium interoperability vector used by the Luau implementation', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = fromHex('000102030405060708090a0b0c0d0e0f1011121314151617');
    const plaintext = Buffer.from('Synex interoperable XChaCha20-Poly1305 vector');
    const aad = Buffer.from('synex:aad:v1');
    const { ciphertext, tag } = sealXChaCha20Poly1305(key, nonce, plaintext, aad);

    assert.equal(
      Buffer.concat([ciphertext, tag]).toString('hex'),
      'cdbb611ae8f2e4c0472154a1bb37da89292b4d85a595758a3c725e840d80a536327f87d771522912b0f6da36bd805a85e932a324f60d3023812880f67c',
    );
    assert.deepEqual(openXChaCha20Poly1305(key, nonce, ciphertext, tag, aad), plaintext);
  });

  test('authenticates AAD and ciphertext before returning plaintext', () => {
    const key = Buffer.alloc(32, 0x41);
    const nonce = Buffer.alloc(24, 0x22);
    const plaintext = Buffer.from('multi-block payload: '.repeat(12));
    const aad = Buffer.from('prototype:9;record:17');
    const { ciphertext, tag } = sealXChaCha20Poly1305(key, nonce, plaintext, aad);

    assert.deepEqual(openXChaCha20Poly1305(key, nonce, ciphertext, tag, aad), plaintext);
    assert.equal(openXChaCha20Poly1305(key, nonce, ciphertext, tag, Buffer.from('changed')), null);

    const altered = Buffer.from(ciphertext);
    altered[altered.length - 1] ^= 1;
    assert.equal(openXChaCha20Poly1305(key, nonce, altered, tag, aad), null);
    assert.equal(openXChaCha20Poly1305(key, nonce, ciphertext, Buffer.alloc(15), aad), null);
  });

  test('supports empty plaintext and AAD', () => {
    const key = Buffer.alloc(32, 0x19);
    const nonce = Buffer.alloc(24, 0x37);
    const { ciphertext, tag } = sealXChaCha20Poly1305(key, nonce, Buffer.alloc(0));
    assert.equal(ciphertext.length, 0);
    assert.equal(tag.length, 16);
    assert.deepEqual(openXChaCha20Poly1305(key, nonce, ciphertext, tag), Buffer.alloc(0));
  });

  test('rejects invalid key and nonce sizes', () => {
    assert.throws(() => sealXChaCha20Poly1305(Buffer.alloc(31), Buffer.alloc(24), Buffer.alloc(0)), /key must be 32 bytes/);
    assert.throws(() => sealXChaCha20Poly1305(Buffer.alloc(32), Buffer.alloc(23), Buffer.alloc(0)), /nonce must be 24 bytes/);
  });
});
