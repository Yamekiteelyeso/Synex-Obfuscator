local Crypto = require("../crypto")
local Integrity = require("../integrity")
local function hex(s)
	return (string.gsub(s, ".", function(c) return string.format("%02x", string.byte(c)) end))
end
local function unhex(s)
	return (string.gsub(s, "%x%x", function(pair) return string.char(tonumber(pair, 16)) end))
end
local function expect(actual, expected, label)
	assert(actual == expected, label .. ": expected " .. expected .. ", got " .. actual)
end

expect(hex(Crypto.sha256("abc")),
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256")
expect(hex(Crypto.hmacSha256("key", "The quick brown fox jumps over the lazy dog")),
	"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", "HMAC-SHA-256")

local polyKey = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b")
expect(hex(Crypto.poly1305("Cryptographic Forum Research Group", polyKey)),
	"a8061dc1305136c6c22b8baf0c0127a9", "Poly1305 RFC vector")

local key = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
local nonce16 = unhex("000000090000004a0000000031415927")
expect(hex(Crypto.hchacha20(key, nonce16)),
	"82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc", "HChaCha20")

local nonce12 = unhex("000000090000004a00000000")
local block = Crypto.chachaBlock(key, nonce12, 1)
expect(hex(string.sub(block, 1, 64)),
	"10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e" ..
	"d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e", "ChaCha20 block")

local nonce24 = unhex("000000000000000000000000000000000000000000000001")
local message = "Synex Luau cryptographic self-test\0payload"
local aad = "prototype:7;instruction:12"
local ciphertext, tag = Crypto.seal(key, nonce24, message, aad)
local plaintext, err = Crypto.open(key, nonce24, ciphertext, tag, aad)
assert(plaintext == message, "authenticated round-trip failed: " .. tostring(err))
local badCipher = string.sub(ciphertext, 1, #ciphertext - 1) ..
	string.char((string.byte(ciphertext, #ciphertext) + 1) % 256)
assert(Crypto.open(key, nonce24, badCipher, tag, aad) == nil, "tampered ciphertext accepted")
assert(Crypto.open(key, nonce24, ciphertext, tag, aad .. "!") == nil, "tampered AAD accepted")
assert(Crypto.open(key, nonce24, ciphertext, string.rep("\0", 32), aad) == nil, "tampered tag accepted")

local aeadCipher, aeadTag = Crypto.sealPoly1305(key, nonce24, message, aad)
assert(#aeadTag == 16, "XChaCha20-Poly1305 tag must be 16 bytes")
local aeadPlain, aeadErr = Crypto.openPoly1305(key, nonce24, aeadCipher, aeadTag, aad)
assert(aeadPlain == message, "XChaCha20-Poly1305 round-trip failed: " .. tostring(aeadErr))
assert(Crypto.openPoly1305(key, nonce24, aeadCipher, aeadTag, aad .. "!") == nil,
	"XChaCha20-Poly1305 accepted modified AAD")
local badAeadTag = string.sub(aeadTag, 1, 15) .. string.char((string.byte(aeadTag, 16) + 1) % 256)
assert(Crypto.openPoly1305(key, nonce24, aeadCipher, badAeadTag, aad) == nil,
	"XChaCha20-Poly1305 accepted modified tag")

local chainKey = "0123456789abcdef0123456789abcdef"
local previous = Integrity.start(chainKey, 5)
local current = Integrity.advanceRecord(chainKey, previous, 1, nonce24, ciphertext, tag, aad)
local valid = Integrity.verifyRecord(chainKey, current, previous, 1, nonce24, ciphertext, tag, aad)
assert(valid, "valid static record chain rejected")
local invalid = Integrity.verifyRecord(chainKey, current, previous, 1, nonce24, ciphertext .. "x", tag, aad)
assert(not invalid, "mutated record accepted by integrity chain")

print("Synex Luau crypto tests passed")
