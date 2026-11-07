export type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'name' | 'text';
export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'type', 'until', 'while', 'typeof',
]);

/**
 * Resaltado de sintaxis para Luau. Tokenizador de una pasada, sin dependencias.
 * Devuelve fragmentos consecutivos que cubren todo el texto original.
 */
export function highlight(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, text: string) => { if (text) out.push({ kind, text }); };
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = /^--\[(=*)\[[\s\S]*?\]\1\]/.exec(rest)) || (m = /^--[^\n]*/.exec(rest))) {
      push('comment', m[0]); i += m[0].length; continue;
    }
    if ((m = /^\[(=*)\[[\s\S]*?\]\1\]/.exec(rest)) || (m = /^"(?:\\[\s\S]|[^"\\\n])*"?/.exec(rest)) || (m = /^'(?:\\[\s\S]|[^'\\\n])*'?/.exec(rest))) {
      push('string', m[0]); i += m[0].length; continue;
    }
    if ((m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/.exec(rest))) {
      push('number', m[0]); i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      push(KEYWORDS.has(m[0]) ? 'keyword' : 'name', m[0]); i += m[0].length; continue;
    }
    if ((m = /^(?:\.\.\.|\.\.=|\/\/=|\.\.|==|~=|<=|>=|\/\/|->|::|\+=|-=|\*=|\/=|%=|\^=|[-+*\/%^#<>=(){}\[\];:,.&|?@])/.exec(rest))) {
      push('operator', m[0]); i += m[0].length; continue;
    }
    push('text', src[i]); i += 1;
  }
  return out;
}
