import type * as A from '@synex/parser';
import type { AnalysisResult } from '@synex/semantic';
import { LuaError, LuaFunction, LuaTable, type Value } from './values.js';

interface Cell { v: Value }

/** Ámbito de ejecución: celdas indexadas por id de símbolo (del análisis semántico). */
class Scope {
  readonly cells = new Map<number, Cell>();
  varargs: Value[] | null = null;
  constructor(readonly parent: Scope | null) {}
}

type Signal = { k: 'break' } | { k: 'continue' } | { k: 'return'; values: Value[] };

export interface RunOptions {
  /** Límite de sentencias ejecutadas, para cortar bucles infinitos en pruebas. */
  stepLimit?: number;
}

/** Cierre: función Luau definida en el código con su ámbito capturado. */
class Closure extends LuaFunction {
  constructor(
    private readonly interp: Interpreter,
    private readonly func: A.FunctionBody,
    private readonly scope: Scope,
  ) {
    super();
  }

  call(args: Value[]): Value[] {
    return this.interp.callClosure(this.func, this.scope, args);
  }
}

/**
 * Intérprete de referencia para Luau. Ejecuta el AST directamente.
 * Sirve como oráculo para las pruebas de equivalencia: el código original y el
 * ofuscado deben producir la misma salida.
 */
export class Interpreter {
  readonly globals = new LuaTable();
  readonly output: string[] = [];
  private declIds = new Map<object, number>();
  private steps = 0;
  private stepLimit = Infinity;

  constructor(private readonly analysis: AnalysisResult) {
    for (const sym of analysis.symbols) this.declIds.set(sym.decl, sym.id);
  }

  run(chunk: A.Chunk, options: RunOptions = {}): Value[] {
    this.stepLimit = options.stepLimit ?? 5_000_000;
    const scope = new Scope(null);
    scope.varargs = [];
    const sig = this.execBlock(chunk.body, scope);
    return sig && sig.k === 'return' ? sig.values : [];
  }

  // -------------------------------------------------------------- ámbitos

  private declare(scope: Scope, decl: object, value: Value): void {
    const id = this.declIds.get(decl);
    if (id === undefined) throw new Error('declaración sin símbolo: ejecución inconsistente con el análisis');
    scope.cells.set(id, { v: value });
  }

  private cellFor(id: number, scope: Scope): Cell | undefined {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const c = s.cells.get(id);
      if (c) return c;
    }
    return undefined;
  }

  private varargsOf(scope: Scope): Value[] {
    for (let s: Scope | null = scope; s; s = s.parent) {
      if (s.varargs) return s.varargs;
    }
    return [];
  }

  // ----------------------------------------------------------- sentencias

  execBlock(stats: A.Stat[], scope: Scope): Signal | undefined {
    for (const s of stats) {
      const sig = this.exec(s, scope);
      if (sig) return sig;
    }
    return undefined;
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new LuaError('límite de ejecución superado');
  }

  private exec(s: A.Stat, scope: Scope): Signal | undefined {
    this.tick();
    switch (s.kind) {
      case 'Local': {
        const values = this.evalList(s.values, scope, s.bindings.length);
        s.bindings.forEach((b, i) => this.declare(scope, b, values[i]));
        return undefined;
      }
      case 'LocalFunction': {
        // La función se declara antes de crear el cierre para permitir recursión.
        this.declare(scope, s, undefined);
        const cell = this.cellFor(this.declIds.get(s)!, scope)!;
        cell.v = new Closure(this, s.func, scope);
        return undefined;
      }
      case 'Assign': {
        const values = this.evalList(s.values, scope, s.targets.length);
        s.targets.forEach((t, i) => this.assign(t, values[i], scope));
        return undefined;
      }
      case 'CompoundAssign': {
        const cur = this.eval(s.target, scope);
        const rhs = this.eval(s.value, scope);
        this.assign(s.target, this.binary(s.op, cur, rhs, s), scope);
        return undefined;
      }
      case 'CallStat':
        this.evalMulti(s.call, scope);
        return undefined;
      case 'Do':
        return this.execBlock(s.body, new Scope(scope));
      case 'While':
        while (truthy(this.eval(s.cond, scope))) {
          this.tick();
          const sig = this.execBlock(s.body, new Scope(scope));
          if (sig?.k === 'break') break;
          if (sig?.k === 'return') return sig;
        }
        return undefined;
      case 'Repeat': {
        for (;;) {
          this.tick();
          const inner = new Scope(scope);
          const sig = this.execBlock(s.body, inner);
          if (sig?.k === 'break') break;
          if (sig?.k === 'return') return sig;
          // "continue" dentro de repeat salta a la condición, como en Luau.
          if (truthy(this.eval(s.cond, inner))) break;
        }
        return undefined;
      }
      case 'If': {
        for (const c of s.clauses) {
          if (truthy(this.eval(c.cond, scope))) return this.execBlock(c.body, new Scope(scope));
        }
        return s.elseBody ? this.execBlock(s.elseBody, new Scope(scope)) : undefined;
      }
      case 'NumericFor': {
        const start = toNumber(this.eval(s.start, scope), s);
        const limit = toNumber(this.eval(s.limit, scope), s);
        const step = s.step ? toNumber(this.eval(s.step, scope), s) : 1;
        if (step === 0) throw new LuaError("'for' step is zero", s.line, s.column);
        for (let i = start; step > 0 ? i <= limit : i >= limit; i += step) {
          this.tick();
          const inner = new Scope(scope);
          this.declare(inner, s.variable, i);
          const sig = this.execBlock(s.body, inner);
          if (sig?.k === 'break') break;
          if (sig?.k === 'return') return sig;
        }
        return undefined;
      }
      case 'GenericFor': {
        const init = this.evalList(s.exprs, scope, 3);
        const [f, state] = [init[0], init[1]];
        let control = init[2];
        for (;;) {
          this.tick();
          const results = this.callValue(f, [state, control], s);
          if (results[0] === undefined) break;
          control = results[0];
          const inner = new Scope(scope);
          s.bindings.forEach((b, i) => this.declare(inner, b, results[i]));
          const sig = this.execBlock(s.body, inner);
          if (sig?.k === 'break') break;
          if (sig?.k === 'return') return sig;
        }
        return undefined;
      }
      case 'Function': {
        const fn = new Closure(this, s.func, scope);
        this.assign(s.target, fn, scope);
        return undefined;
      }
      case 'Return':
        return { k: 'return', values: this.evalList(s.values, scope, -1) };
      case 'Break':
        return { k: 'break' };
      case 'Continue':
        return { k: 'continue' };
      case 'TypeAlias':
        return undefined;
    }
  }

  // ------------------------------------------------------------ asignación

  private assign(target: A.NameExpr | A.IndexExpr, value: Value, scope: Scope): void {
    if (target.kind === 'Name') {
      const id = this.analysis.references.get(target)?.id;
      const cell = id === undefined ? undefined : this.cellFor(id, scope);
      if (cell) cell.v = value;
      else this.globals.set(target.name, value);
      return;
    }
    const obj = this.eval(target.object, scope);
    const key = this.eval(target.index, scope);
    this.setIndex(obj, key, value, target);
  }

  private setIndex(obj: Value, key: Value, value: Value, at: A.Loc): void {
    if (!(obj instanceof LuaTable)) throw new LuaError(`attempt to index ${typeName(obj)} value`, at.line, at.column);
    obj.set(key, value);
  }

  // --------------------------------------------------------------- llamadas

  callClosure(func: A.FunctionBody, closureScope: Scope, args: Value[]): Value[] {
    const scope = new Scope(closureScope);
    func.params.forEach((p, i) => this.declare(scope, p, args[i]));
    scope.varargs = func.isVararg ? args.slice(func.params.length) : [];
    const sig = this.execBlock(func.body, scope);
    return sig?.k === 'return' ? sig.values : [];
  }

  callValue(f: Value, args: Value[], at: A.Loc): Value[] {
    if (f instanceof LuaFunction) return f.call(args);
    throw new LuaError(`attempt to call ${typeName(f)} value`, at.line, at.column);
  }

  // -------------------------------------------------------------- expresiones

  /** Evalúa una lista con expansión de la última expresión; ajusta a `want` valores si es >= 0. */
  private evalList(exprs: A.Expr[], scope: Scope, want: number): Value[] {
    const out: Value[] = [];
    exprs.forEach((e, i) => {
      if (i === exprs.length - 1) out.push(...this.evalMulti(e, scope));
      else out.push(this.eval(e, scope));
    });
    if (want >= 0) {
      while (out.length < want) out.push(undefined);
      out.length = want;
    }
    return out;
  }

  private evalMulti(e: A.Expr, scope: Scope): Value[] {
    switch (e.kind) {
      case 'Call': {
        const f = this.eval(e.callee, scope);
        const args = this.evalList(e.args, scope, -1);
        return this.callValue(f, args, e);
      }
      case 'MethodCall': {
        const obj = this.eval(e.object, scope);
        const fn = this.index(obj, e.method, e);
        const args = [obj, ...this.evalList(e.args, scope, -1)];
        return this.callValue(fn, args, e);
      }
      case 'Vararg':
        return this.varargsOf(scope);
      default:
        return [this.eval(e, scope)];
    }
  }

  eval(e: A.Expr, scope: Scope): Value {
    switch (e.kind) {
      case 'Nil': return undefined;
      case 'Bool': return e.value;
      case 'Number': return parseNumber(e.raw, e);
      case 'String': return e.value;
      case 'Vararg': return this.varargsOf(scope)[0];
      case 'Function': return new Closure(this, e.func, scope);
      case 'Name': {
        const id = this.analysis.references.get(e)?.id;
        if (id !== undefined) {
          const cell = this.cellFor(id, scope);
          if (cell) return cell.v;
        }
        return this.globals.get(e.name);
      }
      case 'Index':
        return this.index(this.eval(e.object, scope), this.eval(e.index, scope), e);
      case 'Call':
      case 'MethodCall':
        return this.evalMulti(e, scope)[0];
      case 'Binary': {
        if (e.op === 'and') {
          const l = this.eval(e.left, scope);
          return truthy(l) ? this.eval(e.right, scope) : l;
        }
        if (e.op === 'or') {
          const l = this.eval(e.left, scope);
          return truthy(l) ? l : this.eval(e.right, scope);
        }
        return this.binary(e.op, this.eval(e.left, scope), this.eval(e.right, scope), e);
      }
      case 'Unary': {
        const v = this.eval(e.operand, scope);
        if (e.op === 'not') return !truthy(v);
        if (e.op === '-') return -toNumber(v, e);
        // '#'
        if (typeof v === 'string') return v.length;
        if (v instanceof LuaTable) return v.length();
        throw new LuaError(`attempt to get length of ${typeName(v)} value`, e.line, e.column);
      }
      case 'Table': {
        const t = new LuaTable();
        let n = 1;
        e.fields.forEach((f, i) => {
          if (f.kind === 'Positional') {
            if (i === e.fields.length - 1) {
              for (const v of this.evalMulti(f.value, scope)) t.set(n++, v);
            } else {
              t.set(n++, this.eval(f.value, scope));
            }
          } else if (f.kind === 'Named') {
            t.set(f.name, this.eval(f.value, scope));
          } else {
            t.set(this.eval(f.key, scope), this.eval(f.value, scope));
          }
        });
        return t;
      }
      case 'Paren':
        return this.eval(e.expr, scope);
      case 'IfExpr': {
        if (truthy(this.eval(e.cond, scope))) return this.eval(e.then, scope);
        for (const c of e.elseifs) {
          if (truthy(this.eval(c.cond, scope))) return this.eval(c.then, scope);
        }
        return this.eval(e.else, scope);
      }
      case 'TypeAssert':
        return this.eval(e.expr, scope);
    }
  }

  index(obj: Value, key: Value, at: A.Loc): Value {
    if (obj instanceof LuaTable) return obj.get(key);
    if (typeof obj === 'string') {
      const lib = this.globals.get('string');
      return lib instanceof LuaTable ? lib.get(key) : undefined;
    }
    throw new LuaError(`attempt to index ${typeName(obj)} value`, at.line, at.column);
  }

  binary(op: string, a: Value, b: Value, at: A.Loc): Value {
    switch (op) {
      case '+': return toNumber(a, at) + toNumber(b, at);
      case '-': return toNumber(a, at) - toNumber(b, at);
      case '*': return toNumber(a, at) * toNumber(b, at);
      case '/': return toNumber(a, at) / toNumber(b, at);
      case '//': return Math.floor(toNumber(a, at) / toNumber(b, at));
      case '%': {
        const x = toNumber(a, at), y = toNumber(b, at);
        return x - Math.floor(x / y) * y;
      }
      case '^': return Math.pow(toNumber(a, at), toNumber(b, at));
      case '..': return toStr(a, at) + toStr(b, at);
      case '==': return luaEquals(a, b);
      case '~=': return !luaEquals(a, b);
      case '<': return compare(a, b, at, (x, y) => x < y);
      case '<=': return compare(a, b, at, (x, y) => x <= y);
      case '>': return compare(a, b, at, (x, y) => x > y);
      case '>=': return compare(a, b, at, (x, y) => x >= y);
      default:
        throw new LuaError(`operador desconocido ${op}`, at.line, at.column);
    }
  }

  /** Salida de print: una línea por llamada. */
  emit(line: string): void {
    this.output.push(line);
  }
}

export function truthy(v: Value): boolean {
  return v !== undefined && v !== false;
}

export function typeName(v: Value): string {
  if (v === undefined) return 'nil';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (v instanceof LuaTable) return 'table';
  return 'function';
}

export function toStr(v: Value, at: A.Loc): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToString(v);
  throw new LuaError(`attempt to concatenate ${typeName(v)} value`, at.line, at.column);
}

export function numberToString(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  return String(Number(n.toPrecision(14)));
}

export function toNumber(v: Value, at: A.Loc): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  }
  throw new LuaError(`attempt to perform arithmetic on ${typeName(v)} value`, at.line, at.column);
}

function parseNumber(raw: string, at: A.Loc): number {
  const clean = raw.replace(/_/g, '');
  const n = Number(clean);
  if (Number.isNaN(n)) throw new LuaError(`número inválido ${raw}`, at.line, at.column);
  return n;
}

function luaEquals(a: Value, b: Value): boolean {
  return a === b;
}

function compare(a: Value, b: Value, at: A.Loc, f: (x: number | string, y: number | string) => boolean): boolean {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  if (typeof a === 'string' && typeof b === 'string') return f(a, b);
  throw new LuaError(`attempt to compare ${typeName(a)} with ${typeName(b)}`, at.line, at.column);
}
