-- Deterministic build-layout planner. Not a cryptographic RNG.
-- Keys and nonces must come from a trusted build service / CSPRNG.
local M = {}
local MOD = 4294967296
local function rng(seed)
	local state = seed % MOD
	return function()
		state = (state + 0x6d2b79f5) % MOD
		local t = state
		t = bit32.bxor(t, bit32.rshift(t, 15))
		t = (t * bit32.bor(t, 1)) % MOD
		t = bit32.bxor(t, t + (t * bit32.bor(t, 61)) % MOD)
		t = bit32.bxor(t, bit32.rshift(t, 14))
		return (t % MOD) / MOD
	end
end
function M.plan(seed, opcodeNames)
	assert(type(seed) == "number" and seed == math.floor(seed) and seed >= 0 and seed <= 0xffffffff,
		"build seed must be an unsigned 32-bit integer")
	assert(type(opcodeNames) == "table", "opcode names must be a table")
	local names = {}
	for i, name in ipairs(opcodeNames) do
		assert(type(name) == "string" and #name > 0, "opcode names must be non-empty strings")
		names[i] = name
	end
	local random = rng(seed)
	local pool = {}
	for i = 1, #names * 3 do pool[i] = i end
	for i = #pool, 2, -1 do
		local j = math.floor(random() * i) + 1
		pool[i], pool[j] = pool[j], pool[i]
	end
	local opcodes = {}
	for i, name in ipairs(names) do opcodes[name] = pool[i] end
	local salts = {}
	for i = 1, 64 do salts[i] = math.floor(random() * 0x7fffffff) end
	return {seed=seed, opcodes=opcodes, salts=salts}
end
return M
