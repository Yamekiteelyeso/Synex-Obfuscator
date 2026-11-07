import { analyze } from '@synex/semantic';
import { parse } from '@synex/parser';
import { Interpreter, type RunOptions } from './interpreter.js';
import { installStdlib } from './stdlib.js';
import type { Value } from './values.js';

export { Interpreter } from './interpreter.js';
export { LuaError, LuaTable, LuaFunction, NativeFunction, type Value } from './values.js';
export { installStdlib, type LuaEnvironment } from './stdlib.js';
export { truthy, toNumber, toStr, typeName, numberToString } from './interpreter.js';

export interface ExecutionResult {
  /** Líneas emitidas por print, en orden. */
  output: string[];
  /** Valores devueltos por el chunk principal. */
  returned: Value[];
}

/**
 * Ejecuta un script Luau con el intérprete de referencia.
 * Lanza LuaError si el script falla en tiempo de ejecución, o SynexError si no es válido.
 */
export function execute(source: string, options: RunOptions = {}): ExecutionResult {
  const chunk = parse(source);
  const analysis = analyze(chunk);
  const [first] = analysis.diagnostics;
  if (first) throw new Error(`script inválido (${first.code}) ${first.line}:${first.column} ${first.message}`);
  const interp = new Interpreter(analysis);
  installStdlib(interp);
  const returned = interp.run(chunk, options);
  return { output: interp.output, returned };
}
