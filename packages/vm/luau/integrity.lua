-- Integrity helpers for the Synex Luau VM.
-- Static record chains can be generated offline. Runtime state MACs are
-- telemetry unless an external trusted value is available for comparison.
local Crypto = require("./crypto")
local M = {}
local function u32(n)
	n = math.floor(n or 0) % 4294967296
	return string.char(n % 256, math.floor(n / 256) % 256,
		math.floor(n / 65536) % 256, math.floor(n / 16777216) % 256)
end
local function frameString(s)
	return u32(#s) .. s
end
function M.start(key, prototypeSalt)
	assert(type(key) == "string" and #key >= 16, "integrity key must be at least 16 bytes")
	return Crypto.hmacSha256(key, "Synex/VM/record-chain-start\0" .. u32(prototypeSalt or 0))
end
function M.advanceRecord(key, previous, pc, nonce, ciphertext, tag, aad)
	assert(type(previous) == "string" and #previous == 32, "invalid previous chain value")
	assert(type(nonce) == "string" and #nonce == 24, "invalid record nonce")
	assert(type(ciphertext) == "string" and type(tag) == "string", "invalid record bytes")
	aad = aad or ""
	return Crypto.hmacSha256(key, "Synex/VM/record-chain\0" .. previous .. u32(pc)
		.. frameString(nonce) .. frameString(aad) .. frameString(ciphertext) .. frameString(tag))
end
function M.verifyRecord(key, expected, previous, pc, nonce, ciphertext, tag, aad)
	local actual = M.advanceRecord(key, previous, pc, nonce, ciphertext, tag, aad)
	return Crypto.constantTimeEqual(actual, expected), actual
end
function M.stateDigest(key, previous, state)
	assert(type(previous) == "string" and #previous == 32, "invalid previous state digest")
	local values = {state.pc, state.sp, state.previousRegister, state.steps, state.opcode}
	local out = {}
	for i = 1, #values do out[i] = u32(values[i]) end
	return Crypto.hmacSha256(key, "Synex/VM/runtime-state\0" .. previous .. table.concat(out))
end
return M
