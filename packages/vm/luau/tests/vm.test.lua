local Integrity = require("../integrity")
local VM = require("../vm")
local encryptionKey, integrityKey = string.rep("E", 32), string.rep("I", 32)
local nonce, aad = string.rep("\1", 24), "proto:1;record:1"
local instruction = {opcode=7, a=41, b=0, c=0, nextPC=0}
local _, prototypeIntegrityKey = VM.deriveKeys(encryptionKey, integrityKey, 12)
local chain0 = Integrity.start(prototypeIntegrityKey, 12)
local record = VM.sealRecord(encryptionKey, integrityKey, nonce, instruction, chain0, 1, 12, aad)
local otherEncryptionKey = VM.deriveKeys(encryptionKey, integrityKey, 13)
local thisEncryptionKey = VM.deriveKeys(encryptionKey, integrityKey, 12)
assert(otherEncryptionKey ~= thisEncryptionKey, "prototype encryption keys were reused")
local vm = VM.new({records={record}, encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=12, maxSteps=10, maxStack=8})
local handlers = {[7] = function(machine, ins) VM.push(machine, ins.a) end}
local stack, sp, steps = VM.execute(vm, handlers)
assert(sp == 1 and stack[1] == 41 and steps == 1, "VM instruction execution failed")

local damaged = {nonce=record.nonce, ciphertext=record.ciphertext, tag=record.tag,
	chainTag=record.chainTag, aad=record.aad}
damaged.chainTag = string.rep("\0", 32)
local tamperedVM = VM.new({records={damaged}, encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=12, maxSteps=10, maxStack=8})
local ok = pcall(function() VM.execute(tamperedVM, handlers) end)
assert(not ok, "tampered instruction chain was accepted")

local last = string.byte(record.ciphertext, #record.ciphertext)
local bad = {nonce=record.nonce,
	ciphertext=string.sub(record.ciphertext, 1, -2) .. string.char((last + 1) % 256),
	tag=record.tag, chainTag=record.chainTag, aad=record.aad}
local badVM = VM.new({records={bad}, encryptionKey=encryptionKey, integrityKey=integrityKey,
	prototypeSalt=12, maxSteps=10, maxStack=8})
ok = pcall(function() VM.execute(badVM, handlers) end)
assert(not ok, "tampered ciphertext was accepted")
print("Synex Luau VM substrate tests passed")
