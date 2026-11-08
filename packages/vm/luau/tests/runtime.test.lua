local Build = require("../build")
local Compiler = require("../compiler")
local Runtime = require("../runtime")
local VM = require("../vm")
local layout = Build.plan(8080, {"PUSH", "ADD"})
local op = layout.opcodes
local key, mac = string.rep("A", 32), string.rep("B", 32)
local artifact = Compiler.compile({
	{opcode=op.PUSH, a=12, b=0, c=0, nextPC=2},
	{opcode=op.PUSH, a=30, b=0, c=0, nextPC=3},
	{opcode=op.ADD, a=0, b=0, c=0, nextPC=0},
}, {
	encryptionKey=key, integrityKey=mac, prototypeSalt=layout.salts[1],
	nonces={string.rep("\5",24),string.rep("\6",24),string.rep("\7",24)},
})
local handlers = {
	[op.PUSH] = function(machine, ins) VM.push(machine, ins.a) end,
	[op.ADD] = function(machine)
		local right, left = VM.pop(machine), VM.pop(machine)
		VM.push(machine, left + right)
	end,
}
local stack, sp, steps = Runtime.run(artifact, {
	encryptionKey=key, integrityKey=mac, maxSteps=20, maxStack=8,
}, handlers)
assert(sp == 1 and stack[1] == 42 and steps == 3, "runtime wrapper output mismatch")
print("Synex Luau runtime tests passed")
