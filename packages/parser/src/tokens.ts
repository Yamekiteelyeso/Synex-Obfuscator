/** Tipos de token del lexer de Luau. */
export type TokenType =
  | 'Name'
  | 'Keyword'
  | 'Number'
  | 'String'
  | 'Operator'
  | 'Punct'
  | 'EOF';

export interface Token {
  type: TokenType;
  /** Texto literal tal como aparece en el fuente (para strings: el valor ya decodificado). */
  value: string;
  line: number;
  column: number;
  offset: number;
  end: number;
}

/** Palabras reservadas de Luau. */
export const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
  'until', 'while',
  // Extensiones de Luau
  'continue', 'export', 'type', 'typeof',
]);

/**
 * Operadores ordenados de más largo a más corto para el emparejamiento voraz.
 * Incluye los operadores compuestos de Luau (+=, -=, ... ) y el operador de
 * conversión de tipos "::" y el de flecha de tipos "->".
 */
export const OPERATORS = [
  '...', '..=', '//=', '..', '==', '~=', '<=', '>=', '//', '->', '::',
  '+=', '-=', '*=', '/=', '%=', '^=',
  '+', '-', '*', '/', '%', '^', '#', '<', '>', '=', '&', '|',
];

export const PUNCTUATION = new Set(['(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '?', '@']);
