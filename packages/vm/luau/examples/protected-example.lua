-- Example source program represented by a tiny illustrative instruction set.
-- Opcode 1: push integer operand A.
-- Opcode 2: add the top two stack values and push the result.
-- Opcode 3: return (halt).
local Build = require("../build")
local Compiler = require("../compiler")
local Runtime = require("../runtime")

local seed = 20261108
local layout = Build.plan(seed, {"PUSH", "ADD", "HALT"})
local op = layout.opcodes
local encryptionKey = string.rep("S", 32)
local integrityKey = string.rep("Y", 32)
local nonces = {
	string.rep("\1", 24),
	string.rep("\2", 24),
	string.rep("\3", 24),
}
local artifact = Compiler.compile({
	{opcode=op.PUSH, a=19, b=0, c=0, nextPC=2},
	{opcode=op.PUSH, a=23, b=0, c=0, nextPC=3},
	{opcode=op.ADD, a=0, b=0, c=0, nextPC=0},
}, {
	encryptionKey=encryptionKey,
	integrityKey=integrityKey,
	nonces=nonces,
	prototypeSalt=layout.salts[1],
})
local handlers = {}
handlers[op.PUSH] = function(vm, instruction)
	require("../vm").push(vm, instruction.a)
end
handlers[op.ADD] = function(vm)
	local right = require("../vm").pop(vm)
	local left = require("../vm").pop(vm)
	require("../vm").push(vm, left + right)
end
local stack, sp, steps = Runtime.run(artifact, {
	encryptionKey=encryptionKey,
	integrityKey=integrityKey,
	maxSteps=100,
	maxStack=16,
}, handlers)
assert(sp == 1 and stack[1] == 42)
print("protected example result:", stack[1], "steps:", steps)
