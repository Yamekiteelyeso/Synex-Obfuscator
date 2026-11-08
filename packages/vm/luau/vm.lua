-- Authenticated, instruction-at-a-time Luau VM substrate.
-- The TypeScript emitter must encode records with the matching v1 format.
local Crypto = require("./crypto")
local Integrity = require("./integrity")
local M = {}
local MAX_U32 = 4294967295

local function readU32LE(bytes, offset)
	local a, b, c, d = string.byte(bytes, offset, offset + 3)
	if d == nil then return nil end
	return a + b * 256 + c * 65536 + d * 16777216
end
local function decodeRecord(plain, version)
	local count = version == 3 and 9 or 5
	if type(plain) ~= "string" or #plain ~= count * 4 then return nil end
	local values = {}
	for i = 1, count do
		values[i] = readU32LE(plain, (i - 1) * 4 + 1)
		if values[i] == nil then return nil end
	end
	if version == 3 then
		return {opcode=values[1], a=values[2], b=values[3], target=values[4],
			c=values[5], line=values[6], nextPC=values[7], checkA=values[8], checkB=values[9]}
	end
	return {opcode=values[1], a=values[2], b=values[3], c=values[4], nextPC=values[5]}
end
local function runtimeState(vm, instruction)
	return {pc=vm.pc, sp=vm.sp, previousRegister=vm.previousRegister,
		steps=vm.steps + 1, opcode=instruction.opcode}
end

function M.deriveKeys(masterEncryptionKey, masterIntegrityKey, prototypeSalt)
	assert(type(masterEncryptionKey) == "string" and #masterEncryptionKey == 32,
		"master encryption key must be 32 bytes")
	assert(type(masterIntegrityKey) == "string" and #masterIntegrityKey >= 16,
		"master integrity key must be at least 16 bytes")
	local context = tostring(math.floor(prototypeSalt or 0))
	local encryptionKey = Crypto.hmacSha256(masterEncryptionKey, "Synex/prototype-encryption/v1:" .. context)
	local integrityKey = Crypto.hmacSha256(masterIntegrityKey, "Synex/prototype-integrity/v1:" .. context)
	return encryptionKey, integrityKey
end

function M.new(options)
	assert(type(options) == "table", "VM options must be a table")
	assert(type(options.records) == "table", "records must be a table")
	assert(type(options.encryptionKey) == "string" and #options.encryptionKey == 32,
		"encryption key must be 32 bytes")
	assert(type(options.integrityKey) == "string" and #options.integrityKey >= 16,
		"integrity key must be at least 16 bytes")
	local version = options.version or 1
	assert(version == 1 or version == 2 or version == 3, "unsupported bytecode version")
	local count = #options.records
	assert(count > 0, "VM requires at least one instruction")
	local encryptionKey, integrityKey = M.deriveKeys(
		options.encryptionKey, options.integrityKey, options.prototypeSalt or 0)
	return {
		records=options.records, version=version, encryptionKey=encryptionKey,
		integrityKey=integrityKey,
		chain=Integrity.start(integrityKey, options.prototypeSalt or 0),
		stateChain=string.rep("\0", 32),
		pc=options.entryPC or 1, sp=0, stack={}, steps=0, previousRegister=0,
		maxSteps=math.max(1, math.floor(options.maxSteps or 1000000)),
		maxStack=math.max(1, math.floor(options.maxStack or 4096)),
		recordCount=count, halted=false,
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
	if vm.pc < 1 or vm.pc > vm.recordCount then error("attempt to index nil value", 2) end
	local record = vm.records[vm.pc]
	if type(record) ~= "table" or type(record.nonce) ~= "string"
		or type(record.ciphertext) ~= "string" or type(record.tag) ~= "string"
		or type(record.chainTag) ~= "string" then error("attempt to index nil value", 2) end

	local valid, nextChain = Integrity.verifyRecord(vm.integrityKey, record.chainTag,
		vm.chain, vm.pc, record.nonce, record.ciphertext, record.tag, record.aad or "")
	if not valid then error("attempt to concatenate a nil value", 2) end
	local openRecord = (vm.version == 2 or vm.version == 3) and Crypto.openPoly1305 or Crypto.open
	local plain = openRecord(vm.encryptionKey, record.nonce, record.ciphertext, record.tag, record.aad or "")
	if plain == nil then error("attempt to concatenate a nil value", 2) end
	local instruction = decodeRecord(plain, vm.version)
	plain = nil
	if instruction == nil then error("attempt to concatenate a nil value", 2) end

	vm.chain = nextChain
	local state = runtimeState(vm, instruction)
	vm.stateChain = Integrity.stateDigest(vm.integrityKey, vm.stateChain, state)
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
		if nextPC < 0 or nextPC > vm.recordCount then error("attempt to index nil value", 2) end
		vm.pc = nextPC
		handler(vm, instruction)
		if nextPC == 0 then vm.halted = true end
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

function M.encodeRecordV3(instruction)
	local values = {instruction.opcode, instruction.a, instruction.b, instruction.target,
		instruction.c, instruction.line, instruction.nextPC, instruction.checkA, instruction.checkB}
	local out = {}
	for i = 1, 9 do
		local value = values[i]
		assert(type(value) == "number" and value == math.floor(value) and value >= 0 and value <= MAX_U32,
			"instruction fields must be unsigned 32-bit integers")
		out[i] = string.char(value % 256, math.floor(value / 256) % 256,
			math.floor(value / 65536) % 256, math.floor(value / 16777216) % 256)
	end
	return table.concat(out)
end

function M.sealRecord(masterEncryptionKey, masterIntegrityKey, nonce, instruction, previousChain, pc, prototypeSalt, aad, version)
	assert(type(nonce) == "string" and #nonce == 24, "nonce must be 24 bytes")
	local encryptionKey, integrityKey = M.deriveKeys(masterEncryptionKey, masterIntegrityKey, prototypeSalt or 0)
	local plain
	if version == 3 then
		plain = M.encodeRecordV3(instruction)
	else
		plain = M.encodeRecord(instruction.opcode, instruction.a, instruction.b,
			instruction.c, instruction.nextPC)
	end
	local sealRecord = (version == 2 or version == 3) and Crypto.sealPoly1305 or Crypto.seal
	local ciphertext, tag = sealRecord(encryptionKey, nonce, plain, aad or "")
	local chainTag = Integrity.advanceRecord(integrityKey, previousChain, pc, nonce, ciphertext, tag, aad or "")
	return {nonce=nonce, ciphertext=ciphertext, tag=tag, chainTag=chainTag, aad=aad or ""}
end
return M
