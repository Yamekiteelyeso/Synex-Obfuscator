import { SynexError } from '@synex/shared';
import { KEYWORDS, OPERATORS, PUNCTUATION, type Token } from './tokens.js';

/**
 * Lexer de Luau. Convierte el fuente en tokens con posición exacta.
 * Soporta: comentarios de línea y de bloque (con niveles), cadenas con
 * escapes y corchetes largos, números decimales/hex/binarios con "_" y
 * exponentes, y operadores compuestos de Luau.
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  private readonly src: string;

  constructor(source: string) {
    // Normaliza fin de línea para que las posiciones sean consistentes.
    // El fuente se trabaja como bytes (UTF-8 representados en latin1), igual que Luau.
    this.src = utf8ToBytes(source.replace(/\r\n?/g, "\n"));
  }

  tokenize(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const tok = this.next();
      out.push(tok);
      if (tok.type === 'EOF') return out;
    }
  }

  private peek(n = 0): string {
    return this.src[this.pos + n] ?? '';
  }

  private error(msg: string, code = 'E_LEX'): never {
    throw new SynexError(msg, this.line, this.pos - this.lineStart + 1, code);
  }

  /** Registra un salto de línea cuyo carácter "\n" está en el índice idx. */
  private newline(idx: number): void {
    this.line++;
    this.lineStart = idx + 1;
  }

  /** Si hay un corchete largo "[==[" en la posición actual, devuelve su nivel; si no, -1. */
  private longBracketLevel(): number {
    if (this.peek() !== '[') return -1;
    let i = 1;
    while (this.peek(i) === '=') i++;
    return this.peek(i) === '[' ? i - 1 : -1;
  }

  /** Lee un corchete largo de nivel dado y devuelve su contenido. */
  private readLong(level: number): string {
    const open = '[' + '='.repeat(level) + '[';
    const close = ']' + '='.repeat(level) + ']';
    this.pos += open.length;
    // Un salto de línea inmediato tras el corchete de apertura se ignora.
    if (this.peek() === "\n") { this.newline(this.pos); this.pos++; }
    const end = this.src.indexOf(close, this.pos);
    if (end === -1) this.error('corchete largo sin cerrar', 'E_UNFINISHED_LONG');
    const content = this.src.slice(this.pos, end);
    for (let i = this.pos; i < end; i++) {
      if (this.src[i] === "\n") {
        this.newline(i);
      }
    }
    this.pos = end + close.length;
    return content;
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const c = this.peek();
      if (c === "\n") { this.newline(this.pos); this.pos++; continue; }
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { this.pos++; continue; }
      if (c === '-' && this.peek(1) === '-') {
        this.pos += 2;
        const level = this.longBracketLevel();
        if (level >= 0) { this.readLong(level); continue; }
        while (this.pos < this.src.length && this.peek() !== '\n') this.pos++;
        continue;
      }
      return;
    }
  }

  private next(): Token {
    this.skipWhitespaceAndComments();
    const start = this.pos;
    const line = this.line;
    const column = this.pos - this.lineStart + 1;
    const make = (type: Token['type'], value: string): Token =>
      ({ type, value, line, column, offset: start, end: this.pos });

    if (this.pos >= this.src.length) return make('EOF', '');

    const c = this.peek();

    if (isIdentStart(c)) {
      while (isIdentPart(this.peek())) this.pos++;
      const word = this.src.slice(start, this.pos);
      return make(KEYWORDS.has(word) ? 'Keyword' : 'Name', word);
    }

    if (isDigit(c) || (c === '.' && isDigit(this.peek(1)))) {
      return make('Number', this.readNumber());
    }

    if (c === '"' || c === "'") {
      return make('String', this.readQuoted(c));
    }

    if (c === '[') {
      const level = this.longBracketLevel();
      if (level >= 0) return make('String', this.readLong(level));
    }

    for (const op of OPERATORS) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length;
        return make('Operator', op);
      }
    }

    if (PUNCTUATION.has(c)) {
      this.pos++;
      return make('Punct', c);
    }

    // "~" solo es válido como parte de "~=" (ya cubierto arriba).
    return this.error(`carácter no válido '${c}'`, 'E_BAD_CHAR');
  }

  private readNumber(): string {
    const start = this.pos;
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      this.pos += 2;
      while (isHex(this.peek()) || this.peek() === '_') this.pos++;
    } else if (this.peek() === '0' && (this.peek(1) === 'b' || this.peek(1) === 'B')) {
      this.pos += 2;
      while (this.peek() === '0' || this.peek() === '1' || this.peek() === '_') this.pos++;
    } else {
      while (isDigit(this.peek()) || this.peek() === '_') this.pos++;
      if (this.peek() === '.' && this.peek(1) !== '.') {
        this.pos++;
        while (isDigit(this.peek()) || this.peek() === '_') this.pos++;
      }
      if (this.peek() === 'e' || this.peek() === 'E') {
        this.pos++;
        if (this.peek() === '+' || this.peek() === '-') this.pos++;
        if (!isDigit(this.peek())) this.error('exponente sin dígitos', 'E_BAD_NUMBER');
        while (isDigit(this.peek())) this.pos++;
      }
    }
    if (isIdentPart(this.peek())) this.error('número mal formado', 'E_BAD_NUMBER');
    return this.src.slice(start, this.pos);
  }

  /** Lee una cadena entre comillas y devuelve su valor decodificado. */
  private readQuoted(quote: string): string {
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (this.pos >= this.src.length || c === '\n') {
        this.error('cadena sin cerrar', 'E_UNFINISHED_STRING');
      }
      if (c === quote) { this.pos++; return out; }
      if (c !== '\\') { out += c; this.pos++; continue; }
      this.pos++;
      const e = this.peek();
      this.pos++;
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case "\n": out += "\n"; this.newline(this.pos - 1); break;
        case 'z': // \z salta espacios en blanco, incluidos saltos de línea
          while (/\s/.test(this.peek())) {
            if (this.peek() === "\n") this.newline(this.pos);
            this.pos++;
          }
          break;
        case 'x': {
          const h = this.src.substr(this.pos, 2);
          if (!/^[0-9a-fA-F]{2}$/.test(h)) this.error('escape \\x inválido', 'E_BAD_ESCAPE');
          out += String.fromCharCode(parseInt(h, 16));
          this.pos += 2;
          break;
        }
        case 'u': {
          if (this.peek() !== '{') this.error('escape \\u inválido', 'E_BAD_ESCAPE');
          const close = this.src.indexOf('}', this.pos);
          const hex = close === -1 ? '' : this.src.slice(this.pos + 1, close);
          if (!/^[0-9a-fA-F]+$/.test(hex)) this.error('escape \\u inválido', 'E_BAD_ESCAPE');
          out += utf8ToBytes(String.fromCodePoint(parseInt(hex, 16)));
          this.pos = close + 1;
          break;
        }
        default:
          if (isDigit(e)) {
            let digits = e;
            for (let i = 0; i < 2 && isDigit(this.peek()); i++) digits += this.src[this.pos++];
            const code = Number(digits);
            if (code > 255) this.error('escape decimal fuera de rango', 'E_BAD_ESCAPE');
            out += String.fromCharCode(code);
          } else {
            this.error(`escape desconocido '\\${e}'`, 'E_BAD_ESCAPE');
          }
      }
    }
  }
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isHex = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const isIdentStart = (c: string): boolean => /^[A-Za-z_]$/.test(c);
const isIdentPart = (c: string): boolean => /^[A-Za-z0-9_]$/.test(c);

/** Atajo: tokeniza un fuente completo. */
export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}

/** Codifica texto como bytes UTF-8, representados como caracteres latin1 (0-255). */
function utf8ToBytes(s: string): string {
  return unescape(encodeURIComponent(s));
}
