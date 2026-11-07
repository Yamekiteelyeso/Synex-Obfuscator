import { SynexError } from '@synex/shared';
import { tokenize } from './lexer.js';
import type { Token } from './tokens.js';
import type * as A from './ast.js';

/** Palabras que Luau admite como identificadores en contextos no ambiguos. */
const CONTEXTUAL_NAMES = new Set(['type', 'export']);

/** Prioridades binarias {izquierda, derecha}; la derecha menor que la izquierda => asociativo por la derecha. */
const BINARY_PRIORITY: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '..': [9, 8],
  '+': [10, 10], '-': [10, 10],
  '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
  '^': [14, 13],
};

const UNARY_PRIORITY = 12;

const COMPOUND_OPS = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=']);

/**
 * Parser de descenso recursivo para Luau.
 * Produce un AST completo incluyendo anotaciones de tipo, aserciones de tipo
 * ("::"), expresiones "if" y declaraciones "type". La validación semántica
 * (ámbitos, break fuera de bucles, etc.) se hace en @synex/semantic.
 */
export class Parser {
  private readonly toks: Token[];
  private i = 0;

  constructor(source: string) {
    this.toks = tokenize(source);
  }

  parseChunk(): A.Chunk {
    const body = this.block();
    if (this.cur.type !== 'EOF') this.fail(`se esperaba fin de bloque, se encontró '${this.cur.value}'`);
    return { kind: 'Chunk', body, line: 1, column: 1 };
  }

  // ------------------------------------------------------------ utilidades

  private get cur(): Token {
    return this.toks[this.i];
  }

  private peekAt(n: number): Token {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }

  private advance(): Token {
    const t = this.toks[this.i];
    if (t.type !== 'EOF') this.i++;
    return t;
  }

  private isKw(v: string): boolean {
    return this.cur.type === 'Keyword' && this.cur.value === v;
  }

  private isOp(v: string): boolean {
    return this.cur.type === 'Operator' && this.cur.value === v;
  }

  private isPunct(v: string): boolean {
    return this.cur.type === 'Punct' && this.cur.value === v;
  }

  private acceptKw(v: string): boolean {
    if (this.isKw(v)) { this.advance(); return true; }
    return false;
  }

  private acceptOp(v: string): boolean {
    if (this.isOp(v)) { this.advance(); return true; }
    return false;
  }

  private acceptPunct(v: string): boolean {
    if (this.isPunct(v)) { this.advance(); return true; }
    return false;
  }

  private expectKw(v: string): void {
    if (!this.acceptKw(v)) this.fail(`se esperaba '${v}'`);
  }

  private expectOp(v: string): void {
    if (!this.acceptOp(v)) this.fail(`se esperaba '${v}'`);
  }

  private expectPunct(v: string): void {
    if (!this.acceptPunct(v)) this.fail(`se esperaba '${v}'`);
  }

  private isNameToken(t: Token): boolean {
    return t.type === 'Name' || (t.type === 'Keyword' && CONTEXTUAL_NAMES.has(t.value));
  }

  private expectName(): string {
    if (!this.isNameToken(this.cur)) this.fail('se esperaba un identificador');
    return this.advance().value;
  }

  private fail(msg: string): never {
    const t = this.cur;
    throw new SynexError(msg, t.line, t.column, 'E_PARSE');
  }

  private at(t: Token): A.Loc {
    return { line: t.line, column: t.column };
  }

  private blockEnds(): boolean {
    if (this.cur.type === 'EOF') return true;
    if (this.cur.type !== 'Keyword') return false;
    return ['end', 'else', 'elseif', 'until'].includes(this.cur.value);
  }

  // ----------------------------------------------------------- sentencias

  private block(): A.Stat[] {
    const body: A.Stat[] = [];
    for (;;) {
      if (this.acceptPunct(';')) continue;
      if (this.blockEnds()) break;
      if (this.isKw('return')) {
        body.push(this.returnStat());
        break;
      }
      body.push(this.statement());
    }
    return body;
  }

  private returnStat(): A.ReturnStat {
    const t = this.advance();
    const values = this.blockEnds() || this.isPunct(';') ? [] : this.exprList();
    this.acceptPunct(';');
    return { kind: 'Return', values, ...this.at(t) };
  }

  private statement(): A.Stat {
    const t = this.cur;
    if (t.type === 'Keyword') {
      switch (t.value) {
        case 'if': return this.ifStat();
        case 'while': return this.whileStat();
        case 'do': return this.doStat();
        case 'for': return this.forStat();
        case 'repeat': return this.repeatStat();
        case 'function': return this.functionStat();
        case 'local': return this.localStat();
        case 'break': this.advance(); return { kind: 'Break', ...this.at(t) };
        case 'continue': this.advance(); return { kind: 'Continue', ...this.at(t) };
        case 'export':
          if (this.peekAt(1).type === 'Keyword' && this.peekAt(1).value === 'type') {
            this.advance();
            return this.typeAlias(true, t);
          }
          break;
        case 'type':
          if (this.isNameToken(this.peekAt(1)) && (this.peekAt(2).value === '=' || this.peekAt(2).value === '<')) {
            return this.typeAlias(false, t);
          }
          break;
      }
    }
    return this.exprStat();
  }

  private ifStat(): A.IfStat {
    const t = this.advance();
    const clauses: A.IfClause[] = [];
    const cond = this.expr();
    this.expectKw('then');
    clauses.push({ cond, body: this.block() });
    while (this.acceptKw('elseif')) {
      const c = this.expr();
      this.expectKw('then');
      clauses.push({ cond: c, body: this.block() });
    }
    let elseBody: A.Stat[] | null = null;
    if (this.acceptKw('else')) elseBody = this.block();
    this.expectKw('end');
    return { kind: 'If', clauses, elseBody, ...this.at(t) };
  }

  private whileStat(): A.WhileStat {
    const t = this.advance();
    const cond = this.expr();
    this.expectKw('do');
    const body = this.block();
    this.expectKw('end');
    return { kind: 'While', cond, body, ...this.at(t) };
  }

  private doStat(): A.DoStat {
    const t = this.advance();
    const body = this.block();
    this.expectKw('end');
    return { kind: 'Do', body, ...this.at(t) };
  }

  private repeatStat(): A.RepeatStat {
    const t = this.advance();
    const body = this.block();
    this.expectKw('until');
    const cond = this.expr();
    return { kind: 'Repeat', body, cond, ...this.at(t) };
  }

  private binding(): A.Binding {
    const name = this.expectName();
    const type = this.acceptPunct(':') ? this.type() : null;
    return { name, type };
  }

  private forStat(): A.Stat {
    const t = this.advance();
    const first = this.binding();
    if (this.acceptOp('=')) {
      const start = this.expr();
      this.expectPunct(',');
      const limit = this.expr();
      const step = this.acceptPunct(',') ? this.expr() : null;
      this.expectKw('do');
      const body = this.block();
      this.expectKw('end');
      return { kind: 'NumericFor', variable: first, start, limit, step, body, ...this.at(t) };
    }
    const bindings = [first];
    while (this.acceptPunct(',')) bindings.push(this.binding());
    this.expectKw('in');
    const exprs = this.exprList();
    this.expectKw('do');
    const body = this.block();
    this.expectKw('end');
    return { kind: 'GenericFor', bindings, exprs, body, ...this.at(t) };
  }

  private functionStat(): A.FunctionStat {
    const t = this.advance();
    const first = this.expectName();
    let target: A.NameExpr | A.IndexExpr = { kind: 'Name', name: first, ...this.at(t) };
    let method = false;
    while (this.isPunct('.')) {
      this.advance();
      const key = this.expectName();
      target = this.indexNode(target, key, true, t);
    }
    if (this.acceptPunct(':')) {
      const key = this.expectName();
      target = this.indexNode(target, key, true, t);
      method = true;
    }
    const func = this.funcBody(method);
    return { kind: 'Function', target, method, func, ...this.at(t) };
  }

  private indexNode(object: A.Expr, key: string, dot: boolean, at: Token): A.IndexExpr {
    return {
      kind: 'Index',
      object,
      index: { kind: 'String', value: key, ...this.at(at) },
      dot,
      ...this.at(at),
    };
  }

  private localStat(): A.Stat {
    const t = this.advance();
    if (this.acceptKw('function')) {
      const name = this.expectName();
      const func = this.funcBody(false);
      return { kind: 'LocalFunction', name, func, ...this.at(t) };
    }
    const bindings = [this.binding()];
    while (this.acceptPunct(',')) bindings.push(this.binding());
    const values = this.acceptOp('=') ? this.exprList() : [];
    return { kind: 'Local', bindings, values, ...this.at(t) };
  }

  private typeAlias(exported: boolean, t: Token): A.TypeAliasStat {
    this.advance(); // 'type'
    const name = this.expectName();
    const generics = this.genericNames();
    this.expectOp('=');
    const type = this.type();
    return { kind: 'TypeAlias', name, generics, type, exported, ...this.at(t) };
  }

  private exprStat(): A.Stat {
    const t = this.cur;
    const first = this.suffixedExpr();
    if (this.isOp('=') || this.isPunct(',')) {
      const targets: (A.NameExpr | A.IndexExpr)[] = [this.assignable(first)];
      while (this.acceptPunct(',')) targets.push(this.assignable(this.suffixedExpr()));
      this.expectOp('=');
      const values = this.exprList();
      return { kind: 'Assign', targets, values, ...this.at(t) };
    }
    if (this.cur.type === 'Operator' && COMPOUND_OPS.has(this.cur.value)) {
      const opTok = this.advance();
      const value = this.expr();
      return {
        kind: 'CompoundAssign',
        op: opTok.value.slice(0, -1),
        target: this.assignable(first),
        value,
        ...this.at(t),
      };
    }
    if (first.kind === 'Call' || first.kind === 'MethodCall') {
      return { kind: 'CallStat', call: first, ...this.at(t) };
    }
    this.fail('se esperaba una sentencia');
  }

  private assignable(e: A.Expr): A.NameExpr | A.IndexExpr {
    if (e.kind === 'Name' || e.kind === 'Index') return e;
    throw new SynexError('destino de asignación no válido', e.line, e.column, 'E_PARSE');
  }

  // ------------------------------------------------------------ funciones

  private genericNames(): string[] {
    const names: string[] = [];
    if (!this.acceptOp('<')) return names;
    do {
      names.push(this.expectName());
      this.acceptOp('...');
      if (this.acceptOp('=')) this.type();
    } while (this.acceptPunct(','));
    this.expectOp('>');
    return names;
  }

  private funcBody(method: boolean): A.FunctionBody {
    const generics = this.genericNames();
    this.expectPunct('(');
    const params: A.Param[] = [];
    if (method) params.push({ name: 'self', type: null, implicit: true });
    let isVararg = false;
    let varargType: A.TypeNode | null = null;
    if (!this.isPunct(')')) {
      do {
        if (this.acceptOp('...')) {
          isVararg = true;
          varargType = this.acceptPunct(':') ? this.type() : null;
          break;
        }
        const name = this.expectName();
        const type = this.acceptPunct(':') ? this.type() : null;
        params.push({ name, type, implicit: false });
      } while (this.acceptPunct(','));
    }
    this.expectPunct(')');
    const returnTypes = this.acceptPunct(':') ? this.returnTypes() : null;
    const body = this.block();
    const endTok = this.cur;
    this.expectKw('end');
    return { generics, params, isVararg, varargType, returnTypes, body, endLine: endTok.line };
  }

  private returnTypes(): A.TypeNode[] {
    const t = this.type();
    if (t.kind === 'TypePack') return t.types;
    return [t];
  }

  // -------------------------------------------------------------- tipos

  /** Analiza un tipo completo, incluidas uniones e intersecciones. */
  type(): A.TypeNode {
    const t = this.cur;
    this.acceptOp('|');
    const first = this.intersectionType();
    if (!this.isOp('|')) return first;
    const types = [first];
    while (this.acceptOp('|')) types.push(this.intersectionType());
    return { kind: 'TypeUnion', types, ...this.at(t) };
  }

  private intersectionType(): A.TypeNode {
    const t = this.cur;
    this.acceptOp('&');
    const first = this.postfixType();
    if (!this.isOp('&')) return first;
    const types = [first];
    while (this.acceptOp('&')) types.push(this.postfixType());
    return { kind: 'TypeIntersection', types, ...this.at(t) };
  }

  private postfixType(): A.TypeNode {
    let type = this.primaryType();
    while (this.isPunct('?')) {
      const t = this.advance();
      type = { kind: 'TypeOptional', type, ...this.at(t) };
    }
    return type;
  }

  private primaryType(): A.TypeNode {
    const t = this.cur;
    if (t.type === 'Keyword') {
      if (t.value === 'nil') { this.advance(); return { kind: 'TypeRef', name: 'nil', args: [], ...this.at(t) }; }
      if (t.value === 'true' || t.value === 'false') {
        this.advance();
        return { kind: 'TypeSingleton', value: t.value === 'true', ...this.at(t) };
      }
      if (t.value === 'typeof') {
        this.advance();
        this.expectPunct('(');
        const expr = this.expr();
        this.expectPunct(')');
        return { kind: 'TypeTypeof', expr, ...this.at(t) };
      }
    }
    if (t.type === 'String') {
      this.advance();
      return { kind: 'TypeSingleton', value: t.value, ...this.at(t) };
    }
    if (t.type === 'Punct' && t.value === '{') return this.tableType();
    if (t.type === 'Punct' && t.value === '(') return this.parenType();
    if (this.isNameToken(t)) return this.namedType();
    this.fail('se esperaba un tipo');
  }

  private tableType(): A.TypeTable {
    const t = this.advance();
    const props: A.TypeTableProp[] = [];
    const indexers: A.TypeIndexer[] = [];
    while (!this.isPunct('}')) {
      if (this.acceptPunct('[')) {
        const key = this.type();
        this.expectPunct(']');
        this.expectPunct(':');
        indexers.push({ key, value: this.type() });
      } else if (this.isNameToken(this.cur) && this.peekAt(1).type === 'Punct' && this.peekAt(1).value === ':') {
        const name = this.expectName();
        this.advance();
        props.push({ name, type: this.type() });
      } else {
        // Forma de array "{ T }" equivalente a "{ [number]: T }".
        indexers.push({ key: { kind: 'TypeRef', name: 'number', args: [], ...this.at(t) }, value: this.type() });
      }
      if (!(this.acceptPunct(',') || this.acceptPunct(';'))) break;
    }
    this.expectPunct('}');
    return { kind: 'TypeTable', props, indexers, ...this.at(t) };
  }

  /** "(T)" agrupa; "(A, B)" es un paquete; "(A) -> R" o "(a: A) -> R" es una función. */
  private parenType(): A.TypeNode {
    const t = this.advance();
    const params: A.TypeParam[] = [];
    if (!this.isPunct(')')) {
      do {
        let name: string | null = null;
        if (this.isNameToken(this.cur) && this.peekAt(1).type === 'Punct' && this.peekAt(1).value === ':') {
          name = this.expectName();
          this.advance();
        }
        params.push({ name, type: this.type() });
      } while (this.acceptPunct(','));
    }
    this.expectPunct(')');
    if (this.acceptOp('->')) {
      return { kind: 'TypeFunction', params, returns: this.returnTypes(), ...this.at(t) };
    }
    if (params.length === 1 && params[0].name === null) {
      return { kind: 'TypeGroup', type: params[0].type, ...this.at(t) };
    }
    return { kind: 'TypePack', types: params.map((p) => p.type), ...this.at(t) };
  }

  private namedType(): A.TypeRef {
    const t = this.cur;
    let name = this.expectName();
    while (this.isPunct('.')) {
      this.advance();
      name += '.' + this.expectName();
    }
    const args: A.TypeNode[] = [];
    if (this.acceptOp('<')) {
      do { args.push(this.type()); } while (this.acceptPunct(','));
      this.expectOp('>');
    }
    return { kind: 'TypeRef', name, args, ...this.at(t) };
  }

  // -------------------------------------------------------- expresiones

  private exprList(): A.Expr[] {
    const list = [this.expr()];
    while (this.acceptPunct(',')) list.push(this.expr());
    return list;
  }

  expr(): A.Expr {
    return this.subExpr(0);
  }

  private subExpr(limit: number): A.Expr {
    const t = this.cur;
    let left: A.Expr;
    if (this.isKw('not') || this.isOp('-') || this.isOp('#')) {
      this.advance();
      const operand = this.subExpr(UNARY_PRIORITY);
      left = { kind: 'Unary', op: t.value as 'not' | '-' | '#', operand, ...this.at(t) };
    } else {
      left = this.simpleExpr();
    }
    for (;;) {
      const op = this.cur;
      const isBinary =
        (op.type === 'Operator' && op.value in BINARY_PRIORITY) ||
        (op.type === 'Keyword' && (op.value === 'and' || op.value === 'or'));
      if (!isBinary) break;
      const [lp, rp] = BINARY_PRIORITY[op.value];
      if (lp <= limit) break;
      this.advance();
      const right = this.subExpr(rp);
      left = { kind: 'Binary', op: op.value, left, right, ...this.at(op) };
    }
    return left;
  }

  private simpleExpr(): A.Expr {
    const t = this.cur;
    switch (t.type) {
      case 'Number':
        this.advance();
        return { kind: 'Number', raw: t.value, ...this.at(t) };
      case 'String':
        this.advance();
        return { kind: 'String', value: t.value, ...this.at(t) };
      case 'Keyword':
        if (t.value === 'nil') { this.advance(); return { kind: 'Nil', ...this.at(t) }; }
        if (t.value === 'true' || t.value === 'false') {
          this.advance();
          return { kind: 'Bool', value: t.value === 'true', ...this.at(t) };
        }
        if (t.value === 'function') {
          this.advance();
          return { kind: 'Function', func: this.funcBody(false), ...this.at(t) };
        }
        if (t.value === 'if') return this.ifExpr();
        break;
      case 'Operator':
        if (t.value === '...') { this.advance(); return { kind: 'Vararg', ...this.at(t) }; }
        break;
      case 'Punct':
        if (t.value === '{') return this.tableExpr();
        break;
    }
    const e = this.suffixedExpr();
    if (this.acceptOp('::')) {
      const type = this.type();
      return { kind: 'TypeAssert', expr: e, type, ...this.at(t) };
    }
    return e;
  }

  private ifExpr(): A.IfExpr {
    const t = this.advance();
    const cond = this.expr();
    this.expectKw('then');
    const then = this.expr();
    const elseifs: { cond: A.Expr; then: A.Expr }[] = [];
    while (this.acceptKw('elseif')) {
      const c = this.expr();
      this.expectKw('then');
      elseifs.push({ cond: c, then: this.expr() });
    }
    this.expectKw('else');
    const elseExpr = this.expr();
    return { kind: 'IfExpr', cond, then, elseifs, else: elseExpr, ...this.at(t) };
  }

  private primaryExpr(): A.Expr {
    const t = this.cur;
    if (this.isNameToken(t)) {
      this.advance();
      return { kind: 'Name', name: t.value, ...this.at(t) };
    }
    if (this.acceptPunct('(')) {
      const expr = this.expr();
      this.expectPunct(')');
      return { kind: 'Paren', expr, ...this.at(t) };
    }
    this.fail('se esperaba una expresión');
  }

  private suffixedExpr(): A.Expr {
    let e = this.primaryExpr();
    for (;;) {
      const t = this.cur;
      if (t.type === 'Punct' && t.value === '.') {
        this.advance();
        e = this.indexNode(e, this.expectName(), true, t);
      } else if (t.type === 'Punct' && t.value === '[') {
        this.advance();
        const key = this.expr();
        this.expectPunct(']');
        e = { kind: 'Index', object: e, index: key, dot: false, ...this.at(t) };
      } else if (t.type === 'Punct' && t.value === ':') {
        this.advance();
        const method = this.expectName();
        const args = this.callArgs();
        e = { kind: 'MethodCall', object: e, method, args, ...this.at(t) };
      } else if ((t.type === 'Punct' && (t.value === '(' || t.value === '{')) || t.type === 'String') {
        const args = this.callArgs();
        e = { kind: 'Call', callee: e, args, ...this.at(t) };
      } else {
        return e;
      }
    }
  }

  private callArgs(): A.Expr[] {
    const t = this.cur;
    if (t.type === 'String') {
      this.advance();
      return [{ kind: 'String', value: t.value, ...this.at(t) }];
    }
    if (t.type === 'Punct' && t.value === '{') return [this.tableExpr()];
    this.expectPunct('(');
    if (this.acceptPunct(')')) return [];
    const args = this.exprList();
    this.expectPunct(')');
    return args;
  }

  private tableExpr(): A.TableExpr {
    const t = this.advance(); // '{'
    const fields: A.TableField[] = [];
    while (!this.isPunct('}')) {
      if (this.acceptPunct('[')) {
        const key = this.expr();
        this.expectPunct(']');
        this.expectOp('=');
        fields.push({ kind: 'Keyed', key, value: this.expr() });
      } else if (this.isNameToken(this.cur) && this.peekAt(1).type === 'Operator' && this.peekAt(1).value === '=') {
        const name = this.expectName();
        this.advance();
        fields.push({ kind: 'Named', name, value: this.expr() });
      } else {
        fields.push({ kind: 'Positional', value: this.expr() });
      }
      if (!(this.acceptPunct(',') || this.acceptPunct(';'))) break;
    }
    this.expectPunct('}');
    return { kind: 'Table', fields, ...this.at(t) };
  }
}

/** Analiza un fuente Luau completo y devuelve su AST. Lanza SynexError con posición si es inválido. */
export function parse(source: string): A.Chunk {
  return new Parser(source).parseChunk();
}
