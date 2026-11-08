local Build = require("../build")
local names = {"LOAD", "ADD", "CALL", "RETURN", "JUMP"}
local first = Build.plan(123456, names)
local second = Build.plan(123456, names)
local other = Build.plan(123457, names)
for _, name in ipairs(names) do
	assert(first.opcodes[name] == second.opcodes[name], "same seed was not deterministic")
end
local different = false
for _, name in ipairs(names) do
	if first.opcodes[name] ~= other.opcodes[name] then different = true end
end
assert(different, "different seeds did not alter opcode layout")
assert(#first.salts == 64, "expected 64 deterministic prototype salts")
print("Synex Luau build planner tests passed")
