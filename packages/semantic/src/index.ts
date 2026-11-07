import { parse } from '@synex/parser';
import { SynexError } from '@synex/shared';
import { analyze, type AnalysisResult } from './analyzer.js';

export { analyze } from './analyzer.js';
export type { AnalysisResult, Diagnostic, Symbol } from './analyzer.js';

/** Parsea y analiza un fuente. Lanza SynexError con el primer error semántico si existe. */
export function analyzeSource(source: string): AnalysisResult {
  const result = analyze(parse(source));
  const [first] = result.diagnostics;
  if (first) throw new SynexError(first.message, first.line, first.column, first.code);
  return result;
}
