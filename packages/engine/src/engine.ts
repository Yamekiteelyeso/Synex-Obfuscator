import { createHash } from 'node:crypto';
import { SynexError } from '@synex/shared';
import { execute, LuaError, LuaTable, LuaFunction, type Value } from '@synex/runtime';
import { obfuscate } from '@synex/transformations';
import { compileToLuauVm } from '@synex/vm';
import { resolveSettings, type ProfileName, type Technique, type TechniqueSettings } from './profiles.js';

export interface EngineOptions {
  profile: ProfileName;
  seed?: number;
  custom?: Partial<TechniqueSettings>;
  /** Comprueba que el original y el ofuscado producen lo mismo en el intérprete de referencia. */
  checkEquivalence?: boolean;
  /** Límite de tamaño de entrada en bytes. */
  maxInputBytes?: number;
  /** Límite de pasos para la comprobación de equivalencia. */
  equivalenceStepLimit?: number;
}

export interface StageRecord {
  name: string;
  ms: number;
}

export interface EngineResult {
  profile: ProfileName;
  techniques: Technique[];
  code: string;
  digest: string;
  stages: StageRecord[];
  stats: {
    inputBytes: number;
    outputBytes: number;
    symbolsRenamed: number;
    stringsEncoded: number;
    deadBlocks: number;
    totalMs: number;
  };
  equivalence: {
    status: 'equivalent' | 'unverifiable' | 'skipped';
    detail?: string;
  };
}

const DEFAULT_MAX_INPUT = 1024 * 1024;

/**
 * Motor de orquestación: valida la entrada, ejecuta el pipeline del perfil,
 * registra tiempos, añade la marca de Synex, calcula el digest y, si se pide,
 * comprueba la equivalencia con el intérprete de referencia.
 */
export function runProfile(source: string, options: EngineOptions): EngineResult {
  const started = Date.now();
  const maxInput = options.maxInputBytes ?? DEFAULT_MAX_INPUT;
  const inputBytes = Buffer.byteLength(source, 'utf8');
  if (inputBytes > maxInput) {
    throw new SynexError(`el script supera el límite de ${maxInput} bytes`, 1, 1, 'E_LIMIT');
  }
  if (source.trim() === '') throw new SynexError('el script está vacío', 1, 1, 'E_EMPTY');

  const settings = resolveSettings(options.profile, options.custom);
  const has = (t: Technique) => settings.techniques.includes(t);
  const stages: StageRecord[] = [];
  let mark = Date.now();
  let current = 'start';
  const onStage = (name: string) => {
    const now = Date.now();
    if (current !== 'start') stages.push({ name: current, ms: now - mark });
    mark = now;
    current = name;
  };

  const result = obfuscate(source, {
    seed: options.seed ?? 1,
    renameIdentifiers: has('identifiers'),
    encodeStrings: has('strings'),
    transformNumbers: has('numbers'),
    transformExpressions: has('expressions') ? settings.expressionProbability : 0,
    deadCodeDensity: has('deadcode') ? settings.deadCodeDensity : 0,
    controlFlowProbability: has('controlflow') ? settings.controlFlowProbability : 0,
    integrity: has('integrity'),
    onStage,
  });

  let code = result.code;
  const vmEnabled = has('vm');
  if (vmEnabled) {
    onStage('vm');
    code = compileToLuauVm(result.code, options.seed ?? 1);
  }

  // El comentario se agrega al final de todas las transformaciones para que
  // siempre quede en la primera línea, también en salidas virtualizadas.
  const brand = `-- [Synex Obf] | profile: ${options.profile} | vm: ${vmEnabled ? 'on' : 'off'}\n`;
  code = brand + code;

  onStage('integrity');
  const digest = createHash('sha256').update(code, 'utf8').digest('hex');

  let equivalence: EngineResult['equivalence'] = { status: 'skipped' };
  if (options.checkEquivalence) {
    onStage('equivalence');
    equivalence = has('vm')
      ? { status: 'unverifiable', detail: 'la VM se verifica ejecutando el resultado en Lua 5.4 (pruebas), no con el intérprete de referencia' }
      : checkEquivalence(source, code.slice(brand.length), options.equivalenceStepLimit ?? 200_000);
  }
  onStage('done');
  stages.push({ name: current === 'done' ? 'finish' : current, ms: Date.now() - mark });

  return {
    profile: options.profile,
    techniques: settings.techniques,
    code,
    digest,
    stages,
    stats: {
      inputBytes,
      outputBytes: Buffer.byteLength(code, 'utf8'),
      symbolsRenamed: result.stats.symbolsRenamed,
      stringsEncoded: result.stats.stringsEncoded,
      deadBlocks: result.stats.deadBlocks,
      totalMs: Date.now() - started,
    },
    equivalence,
  };
}

/** Serializa un valor de retorno a texto estable para comparar. */
function describe(v: Value): string {
  if (v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof LuaTable) return 'table';
  if (v instanceof LuaFunction) return 'function';
  return '?';
}

function runOutcome(src: string, limit: number): { ok: true; out: string } | { ok: false; error: unknown } {
  try {
    const r = execute(src, { stepLimit: limit });
    return { ok: true, out: JSON.stringify([r.output, r.returned.map(describe)]) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function checkEquivalence(original: string, obfuscated: string, limit: number): EngineResult['equivalence'] {
  const a = runOutcome(original, limit);
  if (a.ok) {
    const b = runOutcome(obfuscated, limit);
    if (b.ok && a.out === b.out) return { status: 'equivalent' };
    throw new SynexError('el código ofuscado no conserva el comportamiento del original', 1, 1, 'E_EQUIVALENCE');
  }
  if (a.error instanceof LuaError) {
    const b = runOutcome(obfuscated, limit);
    if (!b.ok && b.error instanceof LuaError && b.error.message === a.error.message) {
      return { status: 'equivalent', detail: 'mismo error de ejecución' };
    }
    throw new SynexError('el código ofuscado falla de forma distinta al original', 1, 1, 'E_EQUIVALENCE');
  }
  return { status: 'unverifiable', detail: 'el original usa construcciones no soportadas por el intérprete de referencia' };
}
