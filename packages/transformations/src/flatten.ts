import type * as A from '@synex/parser';

/**
 * Aplanado del flujo de control: un bloque de sentencias se convierte en un
 * despachador de estados:
 *
 *   local a, b                      -- variables del bloque, hoisted
 *   local st = <estado inicial>
 *   while true do
 *     if st == <e1> then ... st = <e2>
 *     elseif st == <e2> then ... st = 0
 *     else break end
 *   end
 *   if st == -1 then break end      -- sólo si el bloque tenía break del bucle exterior
 *   if st == -2 then continue end   -- sólo si tenía continue del bucle exterior
 *
 * Los segmentos se reordenan en el código y sus identificadores de estado son
 * aleatorios. Sólo se aplica donde la transformación es segura y se omite en el
 * resto (ver `flattenBlock`).
 */

const SKIP_KEYS = new Set(['line', 'column', 'endLine']);
const MIN_STATEMENTS = 4;
/** Estados reservados para salir del despachador con break / continue del bucle exterior. */
const STATE_BREAK = -1;
const STATE_CONTINUE = -2;

export type Rand = () => number;

/** Recorre el árbol y devuelve verdadero si algún nodo cumple el predicado. */
function anyNode(node: unknown, pred: (n: any) => boolean): boolean {
  if (!node || typeof node !== 'object') return false;
  if (!Array.isArray(node) && pred(node)) return true;
  for (const key of Object.keys(node as object)) {
    if (SKIP_KEYS.has(key)) continue;
    if (anyNode((node as Record<string, unknown>)[key], pred)) return true;
  }
  return false;
}

/** Todos los identificadores del programa (variables, parámetros, nombres). */
export function collectIdentifiers(root: unknown): Set<string> {
  const names = new Set<string>();
  anyNode(root, (n) => {
    if (typeof n.name === 'string') names.add(n.name);
    return false;
  });
  return names;
}

function collectNameReads(node: unknown, into: Set<string>): void {
  anyNode(node, (n) => {
    if (n.kind === 'Name') into.add(n.name);
    return false;
  });
}

function shuffle<T>(items: T[], rand: Rand): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sustituye break/continue del bucle exterior por una asignación de estado
 * seguida de `break` (que sale del despachador). No entra en bucles anidados
 * ni en funciones: sus break/continue pertenecen a otro bucle.
 */
function rewriteJumps(
  list: A.Stat[],
  setState: (value: number, line: number) => A.AssignStat,
  flags: { brk: boolean; cont: boolean },
): A.Stat[] {
  const out: A.Stat[] = [];
  for (const s of list) {
    if (s.kind === 'Break') {
      flags.brk = true;
      out.push(setState(STATE_BREAK, s.line), s);
    } else if (s.kind === 'Continue') {
      flags.cont = true;
      out.push(setState(STATE_CONTINUE, s.line), { kind: 'Break', line: s.line, column: s.column });
    } else if (s.kind === 'Do') {
      out.push({ ...s, body: rewriteJumps(s.body, setState, flags) });
    } else if (s.kind === 'If') {
      out.push({
        ...s,
        clauses: s.clauses.map((c) => ({ ...c, body: rewriteJumps(c.body, setState, flags) })),
        elseBody: s.elseBody ? rewriteJumps(s.elseBody, setState, flags) : s.elseBody,
      });
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Aplana una lista de sentencias. Devuelve null si el bloque no es seguro.
 * Condiciones de seguridad:
 * - Sin "type" (los tipos no se hoistean).
 * - Ninguna variable declarada en el bloque se lee antes de su declaración
 *   (incluido dentro de funciones): si no, la variable hoisted cambiaría el
 *   significado de una lectura externa.
 * - Sin nombres declarados dos veces en el mismo bloque.
 *
 * Las funciones locales (`local function f`) se convierten en `f = function`
 * con `f` hoisted, así su recursión sigue funcionando. Los break/continue del
 * bucle exterior se reescriben con estados reservados (ver `rewriteJumps`).
 */
export function flattenBlock(stats: A.Stat[], rand: Rand, freshName: () => string): A.Stat[] | null {
  if (stats.length < MIN_STATEMENTS) return null;
  if (stats.some((s) => s.kind === 'TypeAlias')) return null;

  const declared: string[] = [];
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    let names: string[];
    const reads = new Set<string>();
    if (s.kind === 'Local') {
      names = s.bindings.map((b) => b.name);
      for (let j = 0; j <= i; j++) collectNameReads(stats[j], reads);
    } else if (s.kind === 'LocalFunction') {
      names = [s.name];
      for (let j = 0; j < i; j++) collectNameReads(stats[j], reads);
    } else {
      continue;
    }
    for (const n of names) {
      if (declared.includes(n) || reads.has(n)) return null;
    }
    declared.push(...names);
  }

  // Sentencias ejecutables: las declaraciones con valor se vuelven asignaciones.
  const units: A.Stat[] = [];
  for (const s of stats) {
    if (s.kind === 'Local') {
      if (s.values.length > 0) {
        units.push({
          kind: 'Assign',
          targets: s.bindings.map((b) => ({ kind: 'Name', name: b.name, line: s.line, column: s.column })),
          values: s.values,
          line: s.line,
          column: s.column,
        } satisfies A.AssignStat);
      }
    } else if (s.kind === 'LocalFunction') {
      units.push({
        kind: 'Assign',
        targets: [{ kind: 'Name', name: s.name, line: s.line, column: s.column }],
        values: [{ kind: 'Function', func: s.func, line: s.line, column: s.column }],
        line: s.line,
        column: s.column,
      } satisfies A.AssignStat);
    } else {
      units.push(s);
    }
  }
  if (units.length < 2) return null;

  const stateVar = freshName();
  const setState = (value: number, line: number): A.AssignStat => ({
    kind: 'Assign',
    targets: [{ kind: 'Name', name: stateVar, line, column: 0 }],
    values: [{ kind: 'Number', raw: String(value), line, column: 0 }],
    line,
    column: 0,
  });

  const flags = { brk: false, cont: false };
  const rewritten = rewriteJumps(units, setState, flags);

  const segments: A.Stat[][] = [];
  for (let i = 0; i < rewritten.length; ) {
    const size = 1 + Math.floor(rand() * 3);
    segments.push(rewritten.slice(i, i + size));
    i += size;
  }
  const n = segments.length;
  // Identificadores de estado distintos y positivos; el estado 0 termina el bucle.
  const ids = shuffle(Array.from({ length: n }, (_, k) => k), rand).map((v) => v * 7 + 11);

  const arms = segments.map((seg, k) => {
    const body = seg.slice();
    const last = body[body.length - 1];
    if (!last || (last.kind !== 'Return' && last.kind !== 'Break')) {
      const next = k + 1 < n ? ids[k + 1] : 0;
      body.push(setState(next, last?.line ?? 0));
    }
    return { id: ids[k], body };
  });

  const clauses = shuffle(arms, rand).map((arm) => ({
    cond: {
      kind: 'Binary',
      op: '==',
      left: { kind: 'Name', name: stateVar, line: 0, column: 0 },
      right: { kind: 'Number', raw: String(arm.id), line: 0, column: 0 },
      line: 0,
      column: 0,
    } satisfies A.BinaryExpr,
    body: arm.body,
  }));

  const dispatcher: A.IfStat = {
    kind: 'If',
    clauses,
    elseBody: [{ kind: 'Break', line: 0, column: 0 }],
    line: 0,
    column: 0,
  };
  const loop: A.WhileStat = {
    kind: 'While',
    cond: { kind: 'Bool', value: true, line: 0, column: 0 },
    body: [dispatcher],
    line: 0,
    column: 0,
  };
  const stateIs = (value: number): A.Expr => ({
    kind: 'Binary',
    op: '==',
    left: { kind: 'Name', name: stateVar, line: 0, column: 0 },
    right: { kind: 'Number', raw: String(value), line: 0, column: 0 },
    line: 0,
    column: 0,
  } as A.BinaryExpr);
  const exitWith = (value: number, stat: A.Stat): A.IfStat => ({
    kind: 'If',
    clauses: [{ cond: stateIs(value), body: [stat] }],
    elseBody: null,
    line: 0,
    column: 0,
  } as unknown as A.IfStat);

  const out: A.Stat[] = [];
  if (declared.length > 0) {
    out.push({
      kind: 'Local',
      bindings: declared.map((name) => ({ name, type: null })),
      values: [],
      line: stats[0].line,
      column: stats[0].column,
    });
  }
  out.push({
    kind: 'Local',
    bindings: [{ name: stateVar, type: null }],
    values: [{ kind: 'Number', raw: String(ids[0]), line: 0, column: 0 }],
    line: 0,
    column: 0,
  });
  out.push(loop);
  if (flags.brk) out.push(exitWith(STATE_BREAK, { kind: 'Break', line: 0, column: 0 }));
  if (flags.cont) out.push(exitWith(STATE_CONTINUE, { kind: 'Continue', line: 0, column: 0 } as A.Stat));
  return out;
}

/**
 * Aplica el aplanado a los bloques que lo admitan, con probabilidad p por bloque.
 * Devuelve el número de bloques aplanados. Los bloques generados no se revisitan.
 */
export function flattenControlFlow(chunk: A.Chunk, rand: Rand, probability: number, freshName: () => string): number {
  if (probability <= 0) return 0;
  let count = 0;
  const visit = (node: any): void => {
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((item) => item && typeof item === 'object' && visit(item));
      else if (v && typeof v === 'object') visit(v);
    }
    // Los repeat comparten ámbito con su condición "until": no se tocan.
    if (node.kind === 'Repeat') return;
    for (const key of ['body', 'elseBody']) {
      const list = node[key];
      if (!Array.isArray(list) || rand() >= probability) continue;
      const out = flattenBlock(list, rand, freshName);
      if (out) {
        node[key] = out;
        count++;
      }
    }
  };
  visit(chunk);
  return count;
}
