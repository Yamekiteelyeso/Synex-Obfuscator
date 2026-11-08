import { analyze } from '@synex/semantic';
import { parse } from '@synex/parser';
import { compile } from '@synex/ir';
import { SynexError } from '@synex/shared';
import type { Value } from '@synex/runtime';
import { VM } from './vm.js';

export { VM, VmClosure } from './vm.js';
export { emitLuauVm, compileToLuauVm, opcodeTable } from './emit.js';
export type { EmitOptions } from './emit.js';
export { validateProto } from './validate.js';
export { sealXChaCha20Poly1305, openXChaCha20Poly1305 } from './xchacha.js';
export { compileLuauRecordsV2, verifyLuauRecordsV2 } from './record-format.js';
export type { ArtifactV2, RecordV2, LuauInstructionV2, CompileRecordV2Options } from './record-format.js';

export interface VmResult {
  output: string[];
  returned: Value[];
}

/** Compila y ejecuta un script Luau en la VM de Synex. */
export function runInVm(source: string, options: { stepLimit?: number } = {}): VmResult {
  const chunk = parse(source);
  const analysis = analyze(chunk);
  const [first] = analysis.diagnostics;
  if (first) throw new SynexError(first.message, first.line, first.column, first.code);
  const proto = compile(chunk, analysis);
  const vm = new VM(options);
  const returned = vm.execute(proto);
  return { output: vm.output, returned };
}
