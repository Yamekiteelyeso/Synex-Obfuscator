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
print("Synex Luau compiler tests passed")
