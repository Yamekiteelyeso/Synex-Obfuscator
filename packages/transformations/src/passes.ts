import type * as A from '@synex/parser';

/** Claves del AST que nunca contienen nodos reescribibles. */
const SKIP_KEYS = new Set(['line', 'column', 'endLine']);

/**
 * Reescribe el AST en postorden: primero los hijos, luego la regla sobre el nodo.
 * El resultado de la regla no se vuelve a reescribir, así que las reglas que
 * generan nodos del mismo tipo no entran en bucle.
 */
export function rewrite(root: object, rule: (n: any) => any | undefined): void {
  for (const key of Object.keys(root)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (root as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') {
          rewrite(item, rule);
          const r = rule(item);
          if (r) v[i] = r;
        }
      });
    } else if (v && typeof v === 'object') {
      rewrite(v, rule);
      const r = rule(v);
      if (r) (root as Record<string, unknown>)[key] = r;
    }
  }
}

/** Constante entera -> (N + K) - K con K aleatorio: la misma constante, distinta representación. */
export function transformNumbers(chunk: A.Chunk, rand: () => number): void {
  rewrite(chunk, (n) => {
    if (n.kind !== 'Number') return undefined;
    const value = Number(n.raw.replace(/_/g, ''));
    if (!Number.isInteger(value) || Math.abs(value) > 1_000_000) return undefined;
    const k = 1 + Math.floor(rand() * 997);
    const m = 2 + Math.floor(rand() * 31);
    const num = (x: number): A.NumberLit => ({ kind: 'Number', raw: String(x), line: n.line, column: n.column });
    const add: A.BinaryExpr = { kind: 'Binary', op: '+', left: num(value), right: num(k), line: n.line, column: n.column };
    const mul: A.BinaryExpr = { kind: 'Binary', op: '*', left: add, right: num(m), line: n.line, column: n.column };
    const correction: A.BinaryExpr = { kind: 'Binary', op: '-', left: mul, right: num(k * m), line: n.line, column: n.column };
    // No se divide: conserva el tipo entero y evita convertir un entero en float (p. ej. 22 -> 22.0).
    return { kind: 'Paren', expr: correction, line: n.line, column: n.column } satisfies A.ParenExpr;
  });
}

/** "a == b" -> "not (a ~= b)" con probabilidad p. Equivalente en Luau, incluido NaN. */
export function transformExpressions(chunk: A.Chunk, rand: () => number, p: number): void {
  rewrite(chunk, (n) => {
    if (n.kind !== 'Binary' || n.op !== '==' || rand() >= p) return undefined;
    const neg: A.BinaryExpr = { kind: 'Binary', op: '~=', left: n.left, right: n.right, line: n.line, column: n.column };
    const paren: A.ParenExpr = { kind: 'Paren', expr: neg, line: n.line, column: n.column };
    return { kind: 'Unary', op: 'not', operand: paren, line: n.line, column: n.column } satisfies A.UnaryExpr;
  });
}

/**
 * Inserta bloques muertos: "if (k*k)%4 == 3 then local x = k end".
 * El predicado es falso para todo entero k, así que nunca se ejecutan.
 * Se insertan antes de sentencias existentes; nunca después de un return
 * (el return siempre es la última sentencia del bloque).
 */
export function insertDeadCode(
  chunk: A.Chunk,
  rand: () => number,
  density: number,
  freshName: () => string,
): void {
  if (density <= 0) return;
  const junk = (): A.IfStat => {
    const k = 1 + Math.floor(rand() * 500);
    const lit = (x: number): A.NumberLit => ({ kind: 'Number', raw: String(x), line: 0, column: 0 });
    const sq: A.BinaryExpr = { kind: 'Binary', op: '*', left: lit(k), right: lit(k), line: 0, column: 0 };
    const mod: A.BinaryExpr = { kind: 'Binary', op: '%', left: sq, right: lit(4), line: 0, column: 0 };
    const cond: A.BinaryExpr = { kind: 'Binary', op: '==', left: mod, right: lit(3), line: 0, column: 0 };
    const body: A.LocalStat = {
      kind: 'Local',
      bindings: [{ name: freshName(), type: null }],
      values: [lit(k)],
      line: 0,
      column: 0,
    };
    return { kind: 'If', clauses: [{ cond, body: [body] }], elseBody: null, line: 0, column: 0 };
  };

  const visit = (node: object): void => {
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = (node as Record<string, unknown>)[key];
      if ((key === 'body' || key === 'elseBody') && Array.isArray(v)) {
        const out: A.Stat[] = [];
        for (const s of v as A.Stat[]) {
          // Se visitan solo las sentencias originales; los bloques insertados no se revisitan.
          visit(s);
          if (rand() < density) out.push(junk());
          out.push(s);
        }
        (node as Record<string, unknown>)[key] = out;
      } else if (Array.isArray(v)) {
        v.forEach((item) => item && typeof item === 'object' && visit(item));
      } else if (v && typeof v === 'object') {
        visit(v);
      }
    }
  };
  visit(chunk);
}
