import type { AnalysisResult } from '@synex/semantic';

/**
 * Renombra todas las variables locales, parámetros y funciones locales del AST.
 * Modifica el AST in situ: los nodos de referencia y de declaración reciben el
 * nuevo nombre. Los globales y "self" no se tocan ("self" es implícito en los
 * métodos y su nombre no es elegible).
 *
 * @returns mapa símbolo.id -> nombre nuevo, para verificación y estadísticas.
 */
export function renameLocals(
  analysis: AnalysisResult,
  newName: () => string,
): Map<number, string> {
  const names = new Map<number, string>();
  for (const sym of analysis.symbols) {
    if (sym.kind === 'self') continue;
    const name = newName();
    names.set(sym.id, name);
    sym.decl.name = name;
  }
  for (const [node, sym] of analysis.references) {
    const name = names.get(sym.id);
    if (name !== undefined) node.name = name;
  }
  return names;
}
