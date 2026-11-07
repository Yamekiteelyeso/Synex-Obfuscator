export { obfuscate } from './pipeline.js';
export type { ObfuscateOptions, ObfuscateResult } from './pipeline.js';
export { renameLocals } from './rename.js';
export { createStringEncoder } from './strings.js';
export type { StringEncoder, StringEncoderNames } from './strings.js';
export { createRng, createNameGenerator } from './random.js';
export { transformNumbers, transformExpressions, insertDeadCode, rewrite } from './passes.js';
export { flattenBlock, flattenControlFlow, collectIdentifiers } from './flatten.js';
