-- Public entrypoint for the modular Luau record VM.
-- A production emitter should inline/package these modules in its generated payload.
local VM = require("./vm")
local M = {}
function M.run(artifact, options, handlers)
	assert(type(artifact) == "table" and (artifact.version == 1 or artifact.version == 2), "unsupported bytecode version")
	assert(type(options) == "table", "runtime options are required")
	local machine = VM.new({
		records=artifact.records,
		version=artifact.version,
		encryptionKey=options.encryptionKey,
		integrityKey=options.integrityKey,
		prototypeSalt=artifact.prototypeSalt,
		entryPC=options.entryPC,
		maxSteps=options.maxSteps,
		maxStack=options.maxStack,
	})
	return VM.execute(machine, handlers)
end
return M
