-- Authenticated, instruction-at-a-time Luau VM substrate.
-- This module is a runtime foundation; the TypeScript emitter must encode
-- records using the documented fixed-width format before generated payloads use it.
local Crypto = require("./crypto")
local Integrity = require("./integrity")

local M = {}
local MAX_U32 = 4294967295

local function readU32LE(bytes, offset)
	local a, b, c, d = string.byte(bytes, offset, offset + 3)
	if d == nil then return nil end
	return a + b * 256 + c * 65536 + d * 16777216
end

local function decodeRecord(plain)
	-- Version 1: opcode, a, b, c, nextPC (five unsigned LE 32-bit words).
	if type(plain) ~= "string" or #plain ~= 20 then
		return nil, "invalid instruction record"
	end
	local values = {}
	for i = 1, 5 do
		values[i] = readU32LE(plain, (i - 1) * 4 + 1)
		if values[i] == nil then return nil, "truncated instruction record" end
	end
	return {
		opcode = values[1], a = values[2], b = values[3],
		c = values[4], nextPC = values[5],
	}
end

local function makeState(vm, instruction)
	return {
		pc = vm.pc,
		sp = vm.sp,
		previousRegister = vm.previousRegister,
		steps = vm.steps + 1,
		opcode = instruction.opcode,
	}
end

function M.new(options)
	assert(type(options) == "table", "VM options must be a table")
	assert(type(options.records) == "table", "records must be a table")
	assert(type(options.encryptionKey) == "string" and #options.encryptionKey == 32,
		"encryption key must be 32 bytes")
	assert(type(options.integrityKey) == "string" and #options.integrityKey >= 16,
		"integrity key must be at least 16 bytes")
	local count = #options.records
	assert(count > 0, "VM requires at least one instruction")
	local maxSteps = math.max(1, math.floor(options.maxSteps or 1000000))
	local maxStack = math.max(1, math.floor(options.maxStack or 4096))
	return {
		records = options.records,
		encryptionKey = options.encryptionKey,
		integrityKey = options.integrityKey,
		chain = Integrity.start(options.integrityKey, options.prototypeSalt or 0),
		pc = options.entryPC or 1,
		sp = 0,
		stack = {},
		steps = 0,
		previousRegister = 0,
		maxSteps = maxSteps,
		maxStack = maxStack,
		recordCount = count,
		halted = false,
	}
end

function M.push(vm, value)
	if vm.sp >= vm.maxStack then error("stack overflow", 2) end
	vm.sp = vm.sp + 1
	vm.stack[vm.sp] = value
	return value
end

function M.pop(vm)
	if vm.sp <= 0 then error("attempt to index nil value", 2) end
	local value = vm.stack[vm.sp]
	vm.stack[vm.sp] = nil
	vm.sp = vm.sp - 1
	return value
end

function M.readInstruction(vm)
	if vm.halted then return nil end
	if vm.steps >= vm.maxSteps then error("stack overflow", 2) end
	if vm.pc == 0 then vm.halted = true; return nil end
	if vm.pc < 1 or vm.pc > vm.recordCount then
		error("attempt to index nil value", 2)
	end

	local record = vm.records[vm.pc]
	if type(record) ~= "table" or type(record.nonce) ~= "string"
		or type(record.ciphertext) ~= "string" or type(record.tag) ~= "string"
		or type(record.chainTag) ~= "string" then
		error("attempt to index nil value", 2)
	end

	-- Only the current record is decrypted; the full plaintext bytecode is not
	-- assembled by this reader. Luau strings are immutable, so true zeroization
	-- of a plaintext string cannot be guaranteed by the language runtime.
	local plain = Crypto.open(vm.encryptionKey, record.nonce, record.ciphertext, record.tag, record.aad or "")
	if plain == nil then error("attempt to concatenate a nil value", 2) end
	local instruction = decodeRecord(plain)
	plain = nil
	if instruction == nil then error("attempt to concatenate a nil value", 2) end

	local state = makeState(vm, instruction)
	local valid, nextChain = Integrity.verify(vm.integrityKey, record.chainTag, vm.chain, state)
	if not valid then error("attempt to concatenate a nil value", 2) end
	vm.chain = nextChain
	vm.steps = state.steps
	vm.previousRegister = instruction.a
	return instruction
end

function M.execute(vm, handlers)
	assert(type(vm) == "table" and type(handlers) == "table", "invalid VM execution arguments")
	while not vm.halted do
		local instruction = M.readInstruction(vm)
		if instruction == nil then break end
		local handler = handlers[instruction.opcode]
		if type(handler) ~= "function" then error("attempt to call a nil value", 2) end
		local oldPC = vm.pc
		local nextPC = instruction.nextPC
		if nextPC == 0 then nextPC = oldPC < vm.recordCount and (oldPC + 1) or 0 end
		if nextPC < 0 or nextPC > vm.recordCount then
			error("attempt to index nil value", 2)
		end
		vm.pc = nextPC
		handler(vm, instruction)
		if nextPC == 0 then vm.halted = true end
		if vm.pc == oldPC then
			-- Explicit self-loops remain legal but are bounded by maxSteps.
		end
	end
	return vm.stack, vm.sp, vm.steps
end

function M.encodeRecord(opcode, a, b, c, nextPC)
	local values = {opcode or 0, a or 0, b or 0, c or 0, nextPC or 0}
	local out = {}
	for i = 1, 5 do
		local value = values[i]
		assert(type(value) == "number" and value == math.floor(value) and value >= 0 and value <= MAX_U32,
			"instruction fields must be unsigned 32-bit integers")
		out[i] = string.char(value % 256, math.floor(value / 256) % 256,
			math.floor(value / 65536) % 256, math.floor(value / 16777216) % 256)
	end
	return table.concat(out)
end

function M.sealRecord(encryptionKey, integrityKey, nonce, instruction, previousChain, state, aad)
	assert(type(nonce) == "string" and #nonce == 24, "nonce must be 24 bytes")
	local plain = M.encodeRecord(instruction.opcode, instruction.a, instruction.b,
		instruction.c, instruction.nextPC)
	local ciphertext, tag = Crypto.seal(encryptionKey, nonce, plain, aad or "")
	local chainTag = Integrity.advance(integrityKey, previousChain, state)
	return {nonce = nonce, ciphertext = ciphertext, tag = tag, chainTag = chainTag, aad = aad or ""}
end

return M
