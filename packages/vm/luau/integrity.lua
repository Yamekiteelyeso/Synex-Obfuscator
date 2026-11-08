-- Authenticated record-chain helpers for the Synex Luau VM.
-- An embedded MAC key is extractable and is not a trust boundary.
local Crypto = require("./crypto")
local M = {}
local function encodeInteger(value)
	value = math.floor(value or 0)
	local out = {}
	for i = 1, 8 do
		out[i] = string.char(value % 256)
		value = math.floor(value / 256)
	end
	return table.concat(out)
end
local function frame(values)
	local out = {}
	for i = 1, #values do
		local value = values[i]
		if type(value) == "number" then
			out[#out + 1] = "N" .. encodeInteger(value)
		elseif type(value) == "string" then
			out[#out + 1] = "S" .. encodeInteger(#value) .. value
		elseif type(value) == "boolean" then
			out[#out + 1] = value and "T" or "F"
		elseif value == nil then
			out[#out + 1] = "Z"
		else
			error("unsupported integrity field", 2)
		end
	end
	return table.concat(out)
end
function M.start(key, prototypeSalt)
	assert(type(key) == "string" and #key >= 16, "integrity key must be at least 16 bytes")
	return Crypto.hmacSha256(key, "Synex/VM/chain-start\0" .. encodeInteger(prototypeSalt or 0))
end
function M.advance(key, previous, state)
	assert(type(previous) == "string" and #previous == 32, "invalid previous chain value")
	return Crypto.hmacSha256(key, "Synex/VM/instruction\0" .. previous .. frame({
		state.pc, state.sp, state.previousRegister, state.steps, state.opcode,
	}))
end
function M.verify(key, expected, previous, state)
	local actual = M.advance(key, previous, state)
	return Crypto.constantTimeEqual(actual, expected), actual
end
return M
