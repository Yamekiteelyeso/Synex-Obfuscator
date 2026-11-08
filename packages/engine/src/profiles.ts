/** Perfiles públicos de Synex: Basic, Medium y Max. */
type TechStatus = 'implemented' | 'partial' | 'pending';

const TECHNIQUE_TABLE = {
  identifiers: { status: 'implemented', label: 'Renombrado de identificadores' },
  strings: { status: 'implemented', label: 'Protección de cadenas' },
  numbers: { status: 'implemented', label: 'Transformación de constantes' },
  expressions: { status: 'implemented', label: 'Transformación de expresiones' },
  deadcode: { status: 'implemented', label: 'Código muerto' },
  integrity: { status: 'implemented', label: 'Comprobación de integridad' },
  controlflow: { status: 'implemented', label: 'Aplanado del flujo de control' },
  vm: { status: 'implemented', label: 'Virtualización Luau' },
} as const;

export const TECHNIQUES: Record<keyof typeof TECHNIQUE_TABLE, { status: TechStatus; label: string }> = TECHNIQUE_TABLE;
export type Technique = keyof typeof TECHNIQUES;
export type ProfileName = 'basic' | 'medium' | 'max' | 'custom';

export interface TechniqueSettings {
  techniques: Technique[];
  expressionProbability: number;
  deadCodeDensity: number;
  controlFlowProbability: number;
}

const BASIC: TechniqueSettings = {
  techniques: ['identifiers', 'strings'],
  expressionProbability: 0,
  deadCodeDensity: 0,
  controlFlowProbability: 0,
};

const MEDIUM: TechniqueSettings = {
  techniques: ['identifiers', 'strings', 'numbers', 'expressions', 'deadcode', 'controlflow'],
  expressionProbability: 0.8,
  deadCodeDensity: 0.25,
  controlFlowProbability: 0.4,
};

const MAX: TechniqueSettings = {
  techniques: ['identifiers', 'strings', 'numbers', 'expressions', 'deadcode', 'controlflow', 'integrity', 'vm'],
  expressionProbability: 1,
  deadCodeDensity: 0.6,
  controlFlowProbability: 0.85,
};

export const PROFILES: Record<Exclude<ProfileName, 'custom'>, TechniqueSettings> = {
  basic: BASIC,
  medium: MEDIUM,
  max: MAX,
};

export function resolveSettings(profile: ProfileName, custom?: Partial<TechniqueSettings>): TechniqueSettings {
  if (profile !== 'custom') return PROFILES[profile];
  const techniques = (custom?.techniques ?? ['identifiers', 'strings']).filter(
    (t): t is Technique => t in TECHNIQUES && TECHNIQUES[t].status !== 'pending',
  );
  const unique = [...new Set(techniques)];
  if (unique.length === 0) throw new Error('el perfil personalizado necesita al menos una técnica');
  if (unique.includes('integrity') && !unique.includes('strings')) unique.push('strings');
  return {
    techniques: unique,
    expressionProbability: clamp01(custom?.expressionProbability ?? 0.5),
    deadCodeDensity: clamp01(custom?.deadCodeDensity ?? 0.15),
    controlFlowProbability: clamp01(custom?.controlFlowProbability ?? 0.5),
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function unavailable(techniques: Technique[]): Technique[] {
  return techniques.filter((t) => TECHNIQUES[t].status === 'pending');
}
