-- Serializes already-compiled VM instructions into authenticated encrypted records.
-- Nonces are supplied by a trusted build system; this module never invents them.
local VM = require("./vm")
local Integrity = require("./integrity")
local M = {}
function M.compile(instructions, options)
	assert(type(instructions) == "table" and #instructions > 0, "instructions are required")
	assert(type(options) == "table", "compiler options are required")
	assert(type(options.encryptionKey) == "string" and #options.encryptionKey == 32,
		"encryption key must be 32 bytes")
	assert(type(options.integrityKey) == "string" and #options.integrityKey >= 16,
		"integrity key must be at least 16 bytes")
	assert(type(options.nonces) == "table" and #options.nonces == #instructions,
		"one unique nonce is required per instruction")
	local prototypeSalt = math.floor(options.prototypeSalt or 0)
	local _, prototypeIntegrityKey = VM.deriveKeys(
		options.encryptionKey, options.integrityKey, prototypeSalt)
	local chain = Integrity.start(prototypeIntegrityKey, prototypeSalt)
	local records = {}
	local nonceSet = {}
	for index, instruction in ipairs(instructions) do
		local nonce = options.nonces[index]
		assert(type(nonce) == "string" and #nonce == 24, "each nonce must be 24 bytes")
		assert(not nonceSet[nonce], "nonce reuse within a prototype is forbidden")
		nonceSet[nonce] = true
		local aad = (options.aadPrefix or "synex:v1") .. ":" .. tostring(prototypeSalt) .. ":" .. tostring(index)
		local record = VM.sealRecord(options.encryptionKey, options.integrityKey,
			nonce, instruction, chain, index, prototypeSalt, aad)
		records[index] = record
		chain = record.chainTag
	end
	return {version=1, prototypeSalt=prototypeSalt, records=records, finalChain=chain}
end
return M
