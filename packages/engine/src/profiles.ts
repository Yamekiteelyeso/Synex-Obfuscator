/**
 * Técnicas disponibles y su estado real. Solo las marcadas "implemented" pueden
 * activarse; las "pending" se documentan pero no producen transformaciones.
 */
type TechStatus = 'implemented' | 'partial' | 'pending';

const TECHNIQUE_TABLE = {
  identifiers: { status: 'implemented', label: 'Renombrado de identificadores' },
  strings: { status: 'implemented', label: 'Protección de cadenas' },
  numbers: { status: 'implemented', label: 'Transformación de constantes' },
  expressions: { status: 'implemented', label: 'Transformación de expresiones' },
  deadcode: { status: 'implemented', label: 'Código muerto' },
  integrity: { status: 'implemented', label: 'Comprobación de integridad (en tiempo de ejecución)' },
  controlflow: { status: 'implemented', label: 'Aplanado del flujo de control' },
  vm: { status: 'implemented', label: 'Virtualización del código (VM Luau)' },
} as const;

export const TECHNIQUES: Record<keyof typeof TECHNIQUE_TABLE, { status: TechStatus; label: string }> = TECHNIQUE_TABLE;

export type Technique = keyof typeof TECHNIQUES;
export type ProfileName = 'normal' | 'medium' | 'max' | 'basic' | 'advanced' | 'professional' | 'roblox' | 'custom';

export interface TechniqueSettings {
  techniques: Technique[];
  /** Probabilidad de reescribir "==" (solo si "expressions" está activa). */
  expressionProbability: number;
  /** Densidad de código muerto (solo si "deadcode" está activa). */
  deadCodeDensity: number;
  /** Probabilidad de aplanar un bloque (solo si "controlflow" está activa). */
  controlFlowProbability: number;
}

const BASIC: TechniqueSettings = {
  techniques: ['identifiers', 'strings'],
  expressionProbability: 0,
  deadCodeDensity: 0,
  controlFlowProbability: 0,
};

const ADVANCED: TechniqueSettings = {
  techniques: ['identifiers', 'strings', 'numbers', 'expressions', 'deadcode'],
  expressionProbability: 0.5,
  deadCodeDensity: 0.15,
  controlFlowProbability: 0,
};

const PROFESSIONAL: TechniqueSettings = {
  techniques: ['identifiers', 'strings', 'numbers', 'expressions', 'deadcode', 'controlflow', 'integrity'],
  expressionProbability: 1,
  deadCodeDensity: 0.35,
  controlFlowProbability: 0.5,
};

const NORMAL: TechniqueSettings = {
  techniques: ['identifiers', 'strings', 'numbers', 'expressions'],
  expressionProbability: 0.3,
  deadCodeDensity: 0,
  controlFlowProbability: 0,
};

const MEDIUM: TechniqueSettings = {
  ...ADVANCED,
  expressionProbability: 0.8,
  deadCodeDensity: 0.25,
  controlFlowProbability: 0.4,
  techniques: [...ADVANCED.techniques, 'controlflow'],
};

const ROBLOX: TechniqueSettings = {
  // VM habilitada por defecto: resuelve globals del entorno Luau y soporta
  // indexación/callables nativos (Instances, userdata y __call).
  techniques: ['identifiers', 'strings', 'numbers', 'expressions', 'vm'],
  expressionProbability: 0.35,
  deadCodeDensity: 0,
  controlFlowProbability: 0,
};

const MAX: TechniqueSettings = {
  ...PROFESSIONAL,
  expressionProbability: 1,
  deadCodeDensity: 0.6,
  controlFlowProbability: 0.85,
  techniques: [...PROFESSIONAL.techniques, 'vm'],
};

export const PROFILES: Record<Exclude<ProfileName, 'custom'>, TechniqueSettings> = {
  normal: NORMAL,
  medium: MEDIUM,
  max: MAX,
  basic: BASIC,
  advanced: ADVANCED,
  professional: PROFESSIONAL,
  roblox: ROBLOX,
};

/** Resuelve la configuración de un perfil; "custom" usa la selección del usuario. */
export function resolveSettings(profile: ProfileName, custom?: Partial<TechniqueSettings>): TechniqueSettings {
  if (profile !== 'custom') return PROFILES[profile];
  const techniques = (custom?.techniques ?? ['identifiers', 'strings']).filter(
    (t): t is Technique => t in TECHNIQUES && TECHNIQUES[t].status !== 'pending',
  );
  const unique = [...new Set(techniques)];
  if (unique.length === 0) throw new Error('el perfil personalizado necesita al menos una técnica');
  // La comprobación de integridad verifica las tablas de cadenas: necesita la protección de cadenas.
  if (unique.includes('integrity') && !unique.includes('strings')) unique.push('strings');
  const expressionProbability = clamp01(custom?.expressionProbability ?? 0.5);
  const deadCodeDensity = clamp01(custom?.deadCodeDensity ?? 0.15);
  const controlFlowProbability = clamp01(custom?.controlFlowProbability ?? 0.5);
  return { techniques: unique, expressionProbability, deadCodeDensity, controlFlowProbability };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Técnicas que un perfil pediría pero que aún no existen. */
export function unavailable(techniques: Technique[]): Technique[] {
  return techniques.filter((t) => TECHNIQUES[t].status === 'pending');
}
