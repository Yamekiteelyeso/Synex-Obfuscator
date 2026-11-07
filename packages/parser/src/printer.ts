import type * as A from './ast.js';

/** Prioridad izquierda de cada operador binario (misma tabla que el parser). */
const BIN_PRIO: Record<string, number> = {
  or: 1, and: 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '..': 9, '+': 10, '-': 10,
  '*': 11, '/': 11, '//': 11, '%': 11,
  '^': 14,
};

export interface PrintOptions {
  /**
   * Convierte un valor de cadena en una expresión Luau. Por defecto se emite
   * una cadena literal escapada. Las claves de índice con punto ("a.b") nunca
   * pasan por este hook: siempre se imprimen como identificador.
   */
  stringLiteral?: (value: string) => string;
}

/** Escapa una cadena de bytes como literal Luau ASCII puro (escapes decimales de 3 dígitos). */
export function escapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x22) out += '\\"';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c >= 0x7f) out += '\\' + String(c).padStart(3, '0');
    else out += value[i];
  }
  return out + '"';
}

const PREFIX_KINDS = new Set(['Name', 'Index', 'Call', 'MethodCall', 'Paren']);

class Printer {
  constructor(private readonly opts: PrintOptions) {}

  chunk(c: A.Chunk): string {
    return this.block(c.body);
  }

  // ----------------------------------------------------------- bloques

  private block(stats: A.Stat[]): string {
    return stats.map((s) => this.stat(s)).join('');
  }

  private stat(s: A.Stat): string {
    const line = this.statBody(s) + '\n';
    // Evita la ambigüedad de Lua: una sentencia que empieza por "(" se
    // interpretaría como llamada sobre la sentencia anterior.
    return line.startsWith('(') ? ';' + line : line;
  }

  private statBody(s: A.Stat): string {
    switch (s.kind) {
      case 'Local': {
        const names = s.bindings.map((b) => this.binding(b)).join(', ');
        return 'local ' + names + (s.values.length ? ' = ' + this.exprs(s.values) : '');
      }
      case 'LocalFunction':
        return 'local function ' + s.name + this.funcBody(s.func, false);
      case 'Assign':
        return this.exprs(s.targets) + ' = ' + this.exprs(s.values);
      case 'CompoundAssign':
        return this.expr(s.target) + ' ' + s.op + '= ' + this.expr(s.value);
      case 'CallStat':
        return this.expr(s.call);
      case 'Do':
        return 'do\n' + this.block(s.body) + 'end';
      case 'While':
        return 'while ' + this.expr(s.cond) + ' do\n' + this.block(s.body) + 'end';
      case 'Repeat':
        return 'repeat\n' + this.block(s.body) + 'until ' + this.expr(s.cond);
      case 'If': {
        let out = '';
        s.clauses.forEach((c, i) => {
          out += (i === 0 ? 'if ' : 'elseif ') + this.expr(c.cond) + ' then\n' + this.block(c.body);
        });
        if (s.elseBody) out += 'else\n' + this.block(s.elseBody);
        return out + 'end';
      }
      case 'NumericFor': {
        const v = this.binding(s.variable);
        const range = [this.expr(s.start), this.expr(s.limit)];
        if (s.step) range.push(this.expr(s.step));
        return 'for ' + v + ' = ' + range.join(', ') + ' do\n' + this.block(s.body) + 'end';
      }
      case 'GenericFor':
        return 'for ' + s.bindings.map((b) => this.binding(b)).join(', ') + ' in ' +
          this.exprs(s.exprs) + ' do\n' + this.block(s.body) + 'end';
      case 'Function': {
        const t = s.target;
        if (s.method && t.kind === 'Index') {
          return 'function ' + this.expr(t.object) + ':' + (t.index as A.StringLit).value +
            this.funcBody(s.func, true);
        }
        return 'function ' + this.expr(t) + this.funcBody(s.func, false);
      }
      case 'Return':
        return 'return' + (s.values.length ? ' ' + this.exprs(s.values) : '');
      case 'Break':
        return 'break';
      case 'Continue':
        return 'continue';
      case 'TypeAlias': {
        const gen = s.generics.length ? '<' + s.generics.join(', ') + '>' : '';
        return (s.exported ? 'export ' : '') + 'type ' + s.name + gen + ' = ' + this.type(s.type);
      }
    }
  }

  private binding(b: A.Binding): string {
    return b.type ? `${b.name}: ${this.type(b.type)}` : b.name;
  }

  private funcBody(f: A.FunctionBody, method: boolean): string {
    const gen = f.generics.length ? '<' + f.generics.join(', ') + '>' : '';
    const params = f.params
      .filter((p) => !(method && p.implicit))
      .map((p) => (p.type ? `${p.name}: ${this.type(p.type)}` : p.name));
    if (f.isVararg) params.push(f.varargType ? `...: ${this.type(f.varargType)}` : '...');
    let out = gen + '(' + params.join(', ') + ')';
    if (f.returnTypes && f.returnTypes.length) {
      out += ': ' + this.typeList(f.returnTypes);
    }
    return out + '\n' + this.block(f.body) + 'end';
  }

  // -------------------------------------------------------- expresiones

  private exprs(list: A.Expr[]): string {
    return list.map((e) => this.expr(e)).join(', ');
  }

  /** Imprime una expresión que va como prefijo (objeto de índice o llamada). */
  private prefix(e: A.Expr): string {
    const s = this.expr(e);
    return PREFIX_KINDS.has(e.kind) ? s : '(' + s + ')';
  }

  /** Operando de un binario: sólo se añaden paréntesis cuando la precedencia o asociatividad lo exige. */
  private binaryOperand(e: A.Expr, parentOp: string, isLeft: boolean): string {
    const s = this.expr(e);
    if (e.kind === "Binary") {
      const p = BIN_PRIO[parentOp];
      const c = BIN_PRIO[e.op];
      const rightAssoc = parentOp === "^" || parentOp === "..";
      if (c < p || (c === p && isLeft === rightAssoc)) return "(" + s + ")";
    }
    if (e.kind === "IfExpr" || (e.kind === "Unary" && parentOp === "^" && isLeft)) return "(" + s + ")";
    return s;
  }

  /** Operando de un unario: "-" y "not" sólo necesitan paréntesis para binarios de baja prioridad o unarios anidados. */
  private unaryOperand(e: A.Expr): string {
    const s = this.expr(e);
    if (e.kind === "IfExpr" || e.kind === "Unary" || (e.kind === "Binary" && BIN_PRIO[e.op] <= 12)) return "(" + s + ")";
    return s;
  }

  expr(e: A.Expr): string {
    switch (e.kind) {
      case 'Nil': return 'nil';
      case 'Bool': return e.value ? 'true' : 'false';
      case 'Number': return e.raw;
      case 'String':
        return this.opts.stringLiteral ? this.opts.stringLiteral(e.value) : escapeString(e.value);
      case 'Vararg': return '...';
      case 'Function': return 'function' + this.funcBody(e.func, false);
      case 'Name': return e.name;
      case 'Index':
        if (e.dot && e.index.kind === 'String') return this.prefix(e.object) + '.' + e.index.value;
        return this.prefix(e.object) + '[' + this.expr(e.index) + ']';
      case 'Call':
        return this.prefix(e.callee) + '(' + this.exprs(e.args) + ')';
      case 'MethodCall':
        return this.prefix(e.object) + ':' + e.method + '(' + this.exprs(e.args) + ')';
      case 'Binary': {
        return this.binaryOperand(e.left, e.op, true) + " " + e.op + " " + this.binaryOperand(e.right, e.op, false);
      }
      case 'Unary': {
        return (e.op === "not" ? "not " : e.op) + this.unaryOperand(e.operand);
      }
      case 'Table':
        return '{' + e.fields.map((f) => {
          if (f.kind === 'Positional') return this.expr(f.value);
          if (f.kind === 'Named') return `${f.name} = ${this.expr(f.value)}`;
          return `[${this.expr(f.key)}] = ${this.expr(f.value)}`;
        }).join(', ') + '}';
      case 'Paren':
        return '(' + this.expr(e.expr) + ')';
      case 'IfExpr':
        return 'if ' + this.expr(e.cond) + ' then ' + this.expr(e.then) +
          e.elseifs.map((c) => ` elseif ${this.expr(c.cond)} then ${this.expr(c.then)}`).join('') +
          ' else ' + this.expr(e.else);
      case 'TypeAssert':
        const inner = e.expr.kind === "Binary" || e.expr.kind === "Unary" ? "(" + this.expr(e.expr) + ")" : this.expr(e.expr);
        return inner + " :: " + this.type(e.type);
    }
  }

  // ---------------------------------------------------------------- tipos

  private typeList(list: A.TypeNode[]): string {
    if (list.length === 1) return this.type(list[0]);
    return '(' + list.map((t) => this.type(t)).join(', ') + ')';
  }

  private typePart(t: A.TypeNode): string {
    const s = this.type(t);
    return t.kind === 'TypeUnion' || t.kind === 'TypeIntersection' || t.kind === 'TypeFunction' ? '(' + s + ')' : s;
  }

  type(t: A.TypeNode): string {
    switch (t.kind) {
      case 'TypeRef':
        return t.name + (t.args.length ? '<' + t.args.map((a) => this.type(a)).join(', ') + '>' : '');
      case 'TypeSingleton':
        return typeof t.value === 'boolean' ? (t.value ? 'true' : 'false') : escapeString(t.value);
      case 'TypeTable': {
        const entries = [
          ...t.props.map((p) => `${p.name}: ${this.type(p.type)}`),
          ...t.indexers.map((i) => `[${this.type(i.key)}]: ${this.type(i.value)}`),
        ];
        return entries.length ? '{ ' + entries.join(', ') + ' }' : '{}';
      }
      case 'TypeFunction': {
        const params = t.params.map((p) => (p.name ? `${p.name}: ${this.type(p.type)}` : this.type(p.type)));
        return '(' + params.join(', ') + ') -> ' + this.typeList(t.returns);
      }
      case 'TypeUnion':
        return t.types.map((x) => this.typePart(x)).join(' | ');
      case 'TypeIntersection':
        return t.types.map((x) => this.typePart(x)).join(' & ');
      case 'TypeOptional':
        return this.typePart(t.type) + '?';
      case 'TypeTypeof':
        return 'typeof(' + this.expr(t.expr) + ')';
      case 'TypeGroup':
        return '(' + this.type(t.type) + ')';
      case 'TypePack':
        return '(' + t.types.map((x) => this.type(x)).join(', ') + ')';
    }
  }
}

/** Convierte un AST de Luau en código fuente Luau. */
export function printChunk(chunk: A.Chunk, opts: PrintOptions = {}): string {
  return new Printer(opts).chunk(chunk);
}
