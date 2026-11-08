-- Non-cryptographic runtime variation for per-session diversification.
-- Never use this output as a cryptographic key or nonce source.
local M = {}
local MOD = 2147483647
local function safeCall(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, value = pcall(fn, ...)
	if ok then return value end
	return nil
end
local function mix(state, value)
	local text = tostring(value or "")
	for i = 1, #text do
		state = (state * 48271 + string.byte(text, i) + i) % MOD
	end
	return state
end
function M.sample()
	local state = 104729
	local before = safeCall(os and os.clock) or 0
	local temporary = {}
	local address = tostring(temporary)
	local gc = safeCall(collectgarbage, "count") or 0
	local after = safeCall(os and os.clock) or before
	state = mix(state, address)
	state = mix(state, gc)
	state = mix(state, math.floor(math.abs(after - before) * 1000000000))
	state = mix(state, #address)
	state = mix(state, tostring({}))
	temporary = nil
	return state
end
function M.derive(seed, context)
	local state = (math.abs(tonumber(seed) or 0) % MOD) + 1
	state = mix(state, context or "")
	return mix(state, M.sample())
end
function M.capabilities()
	return {
		debugInfo = type(debug) == "table" and type(debug.info) == "function",
		debugGetInfo = type(debug) == "table" and type(debug.getinfo) == "function",
		getfenv = type(getfenv) == "function",
		getgenv = type(getgenv) == "function",
		collectgarbage = type(collectgarbage) == "function",
		clock = type(os) == "table" and type(os.clock) == "function",
	}
end
return M
