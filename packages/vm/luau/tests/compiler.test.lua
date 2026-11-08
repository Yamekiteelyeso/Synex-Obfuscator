local Compiler = require("../compiler")
local VM = require("../vm")
local encryptionKey, integrityKey = string.rep("K", 32), string.rep("M", 32)
local instructions = {
	{opcode=3, a=20, b=0, c=0, nextPC=2},
	{opcode=3, a=22, b=0, c=0, nextPC=0},
}
local nonces = {string.rep("\2", 24), string.rep("\3", 24)}
local artifact = Compiler.compile(instructions, {
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	nonces=nonces, prototypeSalt=99,
})
assert(artifact.version == 1 and #artifact.records == 2, "compiler record format mismatch")
local vm = VM.new({records=artifact.records, encryptionKey=encryptionKey,
	integrityKey=integrityKey, prototypeSalt=artifact.prototypeSalt, maxSteps=10, maxStack=8})
local handlers = {[3] = function(machine, ins) VM.push(machine, ins.a) end}
local stack, sp, steps = VM.execute(vm, handlers)
assert(sp == 2 and stack[1] == 20 and stack[2] == 22 and steps == 2,
	"compiled two-instruction program did not execute")

local ok = pcall(function()
	Compiler.compile(instructions, {encryptionKey=encryptionKey, integrityKey=integrityKey,
		nonces={string.rep("\4", 24), string.rep("\4", 24)}, prototypeSalt=99})
end)
assert(not ok, "compiler allowed nonce reuse")
-- Version 2 switches record authentication to XChaCha20-Poly1305.
local artifactV2 = Compiler.compile(instructions, {
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	nonces={string.rep(string.char(8), 24), string.rep(string.char(9), 24)},
	prototypeSalt=100, version=2,
})
assert(artifactV2.version == 2, "compiler did not preserve artifact version")
assert(#artifactV2.records[1].tag == 16, "v2 must use a 16-byte Poly1305 tag")
local vmV2 = VM.new({records=artifactV2.records, version=artifactV2.version,
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=artifactV2.prototypeSalt, maxSteps=10, maxStack=8})
local stackV2, spV2, stepsV2 = VM.execute(vmV2, handlers)
assert(spV2 == 2 and stackV2[1] == 20 and stackV2[2] == 22 and stepsV2 == 2,
	"v2 Poly1305 artifact did not execute")


-- Version 3 authenticates and encrypts the complete nine-u32 production record.
local fullInstructions = {
	{opcode=3, a=20, b=4, target=7, c=1, line=120045, nextPC=2, checkA=123456, checkB=654321},
	{opcode=3, a=22, b=5, target=0, c=0, line=120062, nextPC=0, checkA=222333, checkB=333222},
}
local artifactV3 = Compiler.compile(fullInstructions, {
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	nonces={string.rep(string.char(10), 24), string.rep(string.char(11), 24)},
	prototypeSalt=101, version=3,
})
assert(artifactV3.version == 3 and #artifactV3.records[1].ciphertext == 36,
	"v3 must encrypt all nine 32-bit fields")
assert(#artifactV3.records[1].tag == 16, "v3 must use a 16-byte Poly1305 tag")
local vmV3 = VM.new({records=artifactV3.records, version=3,
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=artifactV3.prototypeSalt, maxSteps=10, maxStack=8})
local v3Handlers = {[3] = function(machine, ins)
	assert(ins.target == (machine.steps == 1 and 7 or 0), "v3 target field was not decoded")
	assert(ins.line == (machine.steps == 1 and 120045 or 120062), "v3 line field was not decoded")
	assert(ins.checkA > 0 and ins.checkB > 0, "v3 integrity fields were not decoded")
	VM.push(machine, ins.a)
end}
local stackV3, spV3, stepsV3 = VM.execute(vmV3, v3Handlers)
assert(spV3 == 2 and stackV3[1] == 20 and stackV3[2] == 22 and stepsV3 == 2,
	"v3 nine-field artifact did not execute")

local invalidVersion = pcall(function()
	Compiler.compile(instructions, {encryptionKey=encryptionKey, integrityKey=integrityKey,
		nonces=nonces, version=4})
end)
assert(not invalidVersion, "compiler accepted an unknown format version")

local tampered = {
	version=artifactV2.version, prototypeSalt=artifactV2.prototypeSalt,
	records={}, finalChain=artifactV2.finalChain,
}
for i, record in ipairs(artifactV2.records) do
	tampered.records[i] = table.clone(record)
end
tampered.records[1].aad = tampered.records[1].aad .. ":tampered"
local tamperedVm = VM.new({records=tampered.records, version=tampered.version,
	encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=tampered.prototypeSalt})
assert(not pcall(function() VM.readInstruction(tamperedVm) end),
	"v2 accepted a record with modified AAD")
print("Synex Luau compiler tests passed")
