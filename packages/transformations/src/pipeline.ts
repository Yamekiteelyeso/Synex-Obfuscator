import { SynexError } from '@synex/shared';
import { KEYWORDS, parse, printChunk } from '@synex/parser';
import { analyze, type AnalysisResult } from '@synex/semantic';
import { createNameGenerator, createRng } from './random.js';
import { renameLocals } from './rename.js';
import { createStringEncoder, type StringEncoder } from './strings.js';
import { insertDeadCode, transformExpressions, transformNumbers } from './passes.js';
import { collectIdentifiers, flattenControlFlow } from './flatten.js';

export interface ObfuscateOptions {
  /** Semilla determinista. Misma entrada y semilla => misma salida. */
  seed?: number;
  /** Renombrar variables, parámetros y funciones locales. */
  renameIdentifiers?: boolean;
  /** Proteger literales de cadena. */
  encodeStrings?: boolean;
  /** Reescribir constantes enteras como (N + K) - K. */
  transformNumbers?: boolean;
  /** Probabilidad (0..1) de reescribir "==" como "not (~=)". */
  transformExpressions?: number;
  /** Densidad (0..1) de bloques muertos insertados antes de sentencias. */
  deadCodeDensity?: number;
  /** Probabilidad (0..1) de aplanar el flujo de control de cada bloque admisible. */
  controlFlowProbability?: number;
  /** Comprobación en tiempo de ejecución de las tablas de datos (requiere cadenas). */
  integrity?: boolean;
  /** Callback de progreso: recibe el nombre de cada etapa al empezar. */
  onStage?: (stage: string) => void;
}

export interface ObfuscateResult {
  code: string;
  stats: {
    symbolsRenamed: number;
    stringsEncoded: number;
    numbersTransformed: boolean;
    deadBlocks: number;
    flattenedBlocks: number;
    inputBytes: number;
    outputBytes: number;
  };
}

/** Globales que la cabecera de cadenas necesita; son las únicas nuevas permitidas en la salida. */
const RUNTIME_GLOBALS = ['string', 'table', 'bit32', 'error'];

/**
 * Pipeline: parser -> análisis semántico -> renombrado -> reescrituras del AST
 * -> cadenas -> impresión -> verificación de la salida.
 */
export function obfuscate(source: string, options: ObfuscateOptions = {}): ObfuscateResult {
  const {
    seed = 1,
    renameIdentifiers = true,
    encodeStrings = true,
    transformNumbers: doNumbers = false,
    transformExpressions: exprProb = 0,
    deadCodeDensity = 0,
    controlFlowProbability = 0,
    integrity = false,
    onStage = () => {},
  } = options;

  onStage('parse');
  const chunk = parse(source);
  onStage('analyze');
  const analysis: AnalysisResult = analyze(chunk);
  const [first] = analysis.diagnostics;
  if (first) throw new SynexError(first.message, first.line, first.column, first.code);

  const rng = createRng(seed);
  const reserved = new Set<string>([...KEYWORDS, ...analysis.globals, ...RUNTIME_GLOBALS]);

  let encoder: StringEncoder | null = null;
  if (encodeStrings) {
    const freshName = createNameGenerator(rng, reserved);
    encoder = createStringEncoder(
      { table: freshName(), keys: freshName(), cache: freshName(), decode: freshName() },
      rng,
    );
  }

  let symbolsRenamed = 0;
  if (renameIdentifiers) {
    onStage('rename');
    symbolsRenamed = renameLocals(analysis, createNameGenerator(rng, reserved)).size;
  }
  if (doNumbers) {
    onStage('numbers');
    transformNumbers(chunk, rng);
  }
  if (exprProb > 0) {
    onStage('expressions');
    transformExpressions(chunk, rng, exprProb);
  }
  if (deadCodeDensity > 0) {
    onStage('dead-code');
    insertDeadCode(chunk, rng, deadCodeDensity, createNameGenerator(rng, reserved));
  }

  let flattenedBlocks = 0;
  if (controlFlowProbability > 0) {
    onStage('control-flow');
    const used = collectIdentifiers(chunk);
    const gen = createNameGenerator(rng, new Set<string>([...reserved, ...used]));
    const fresh = (): string => {
      let name = gen();
      while (used.has(name)) name = gen();
      used.add(name);
      return name;
    };
    flattenedBlocks = flattenControlFlow(chunk, rng, controlFlowProbability, fresh);
  }

  onStage('generate');
  const body = printChunk(chunk, encoder ? { stringLiteral: (v) => encoder.encode(v) } : {});
  if (integrity && !encoder) throw new SynexError('la comprobación de integridad necesita la protección de cadenas', 1, 1, 'E_OPTIONS');
  const header = encoder && (encoder.count > 0 || integrity) ? encoder.header(integrity) : '';
  const code = header + body;

  onStage('verify');
  verify(code, analysis.globals);

  return {
    code,
    stats: {
      symbolsRenamed,
      stringsEncoded: encoder ? encoder.count : 0,
      numbersTransformed: doNumbers,
      deadBlocks: deadCodeDensity > 0 ? countDeadBlocks(code) : 0,
      flattenedBlocks,
      inputBytes: source.length,
      outputBytes: code.length,
    },
  };
}

function countDeadBlocks(code: string): number {
  return (code.match(/if \(?\(?[^\n]*\*[^\n]*%\s*4\)?\s*== 3 then/g) ?? []).length;
}

/** Red de seguridad: la salida debe ser Luau válido y sin globales nuevos. */
function verify(code: string, originalGlobals: Set<string>): void {
  const out = analyze(parse(code));
  const [first] = out.diagnostics;
  if (first) {
    throw new SynexError(`salida inválida: ${first.message}`, first.line, first.column, 'E_INTERNAL');
  }
  const allowed = new Set([...originalGlobals, ...RUNTIME_GLOBALS]);
  for (const g of out.globals) {
    if (!allowed.has(g)) {
      throw new SynexError(`la salida introduce un global nuevo: ${g}`, 1, 1, 'E_INTERNAL');
    }
  }
}
