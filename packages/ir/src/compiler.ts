import type * as A from '@synex/parser';
import type { AnalysisResult, Symbol as LuaSymbol } from '@synex/semantic';
import { SynexError } from '@synex/shared';
import type { Value } from '@synex/runtime';
import type { Instr, Op, Proto, UpvalDesc } from './bytecode.js';

/** Un símbolo es "capturado" si se referencia desde una función distinta a la que lo declara. */
export function findCaptured(chunk: A.Chunk, analysis: AnalysisResult): Set<number> {
  const symByDecl = new Map<object, LuaSymbol>();
  for (const s of analysis.symbols) symByDecl.set(s.decl, s);
  const owner = new Map<number, object>();
  const captured = new Set<number>();

  const walk = (v: unknown, fn: object): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, fn);
      return;
    }
    if (!v || typeof v !== 'object') return;
    let current = fn;
    if ('params' in v && 'body' in v && 'endLine' in v) current = v; // FunctionBody
    const sym = symByDecl.get(v);
    if (sym) owner.set(sym.id, current);
    const node = v as { kind?: string };
    if (node.kind === 'Name') {
      const ref = analysis.references.get(v as A.NameExpr);
      if (ref && owner.get(ref.id) !== current) captured.add(ref.id);
    }
    for (const key of Object.keys(v)) {
      if (key === 'line' || key === 'column' || key === 'endLine') continue;
      walk((v as Record<string, unknown>)[key], current);
    }
  };
  walk(chunk, chunk);
  return captured;
}

interface Loop {
  breaks: number[];
  continueTarget: number[];
  continueLabel?: number;
}

/** Estado de compilación de una función. */
class FnState {
  readonly proto: Proto;
  readonly slotOf = new Map<number, number>();
  readonly upvalIndex = new Map<number, number>();
  readonly loops: Loop[] = [];
  line = 0;

  constructor(
    readonly parent: FnState | null,
    name: string,
    nparams: number,
    isVararg: boolean,
  ) {
    this.proto = { name, nparams, isVararg, nslots: 0, code: [], consts: [], protos: [], upvals: [] };
  }
}

/**
 * Compilador AST -> IR. Requiere el análisis semántico del mismo AST.
 * Los locales capturados por closures se guardan en celdas ("boxes") para que
 * cada closure comparta la misma variable; el resto vive directamente en slots.
 */
export class Compiler {
  private readonly declSym = new Map<object, LuaSymbol>();
  private readonly captured: Set<number>;
  private fn!: FnState;

  constructor(private readonly chunk: A.Chunk, private readonly analysis: AnalysisResult) {
    for (const s of analysis.symbols) this.declSym.set(s.decl, s);
    this.captured = findCaptured(chunk, analysis);
  }

  compileChunk(): Proto {
    this.fn = new FnState(null, 'main', 0, true);
    this.block(this.chunk.body);
    this.emit('RET', { a: 0, c: false });
    return this.fn.proto;
  }

  // -------------------------------------------------------- utilidades

  private emit(op: Op, extra: Partial<Instr> = {}): number {
    const ins: Instr = { op, line: this.fn.line, ...extra };
    this.fn.proto.code.push(ins);
    return this.fn.proto.code.length - 1;
  }

  private here(): number {
    return this.fn.proto.code.length;
  }

  private patch(at: number, target = this.here()): void {
    this.fn.proto.code[at].t = target;
  }

  private constIndex(v: Value): number {
    const consts = this.fn.proto.consts;
    const i = consts.indexOf(v);
    if (i >= 0) return i;
    consts.push(v);
    return consts.length - 1;
  }

  private newSlot(): number {
    return this.fn.proto.nslots++;
  }

  private at(loc: A.Loc): void {
    this.fn.line = loc.line;
  }

  private isBoxed(id: number): boolean {
    return this.captured.has(id);
  }

  /** Declara un símbolo nuevo en la función actual y devuelve su slot. */
  private declare(decl: object): { slot: number; boxed: boolean } {
    const sym = this.declSym.get(decl);
    if (!sym) throw new SynexError('declaración sin símbolo (análisis inconsistente)', this.fn.line, 0, 'E_INTERNAL');
    const slot = this.newSlot();
    this.fn.slotOf.set(sym.id, slot);
    return { slot, boxed: this.isBoxed(sym.id) };
  }

  /** Guarda el valor del tope de la pila en un local recién declarado. */
  private initLocal(decl: object): void {
    const { slot, boxed } = this.declare(decl);
    this.emit(boxed ? 'NEWBOX' : 'SETL', { a: slot });
  }

  private resolveUpval(fn: FnState, id: number): number {
    const known = fn.upvalIndex.get(id);
    if (known !== undefined) return known;
    if (!fn.parent) return -1;
    let desc: UpvalDesc;
    const parentSlot = fn.parent.slotOf.get(id);
    if (parentSlot !== undefined) {
      desc = { fromLocal: true, index: parentSlot };
    } else {
      const up = this.resolveUpval(fn.parent, id);
      if (up < 0) return -1;
      desc = { fromLocal: false, index: up };
    }
    fn.proto.upvals.push(desc);
    const idx = fn.proto.upvals.length - 1;
    fn.upvalIndex.set(id, idx);
    return idx;
  }

  // -------------------------------------------------------- sentencias

  private block(stats: A.Stat[]): void {
    for (const s of stats) this.stat(s);
  }

  private stat(s: A.Stat): void {
    this.at(s);
    switch (s.kind) {
      case 'Local': {
        this.exprListFixed(s.values, s.bindings.length);
        for (let i = s.bindings.length - 1; i >= 0; i--) this.initLocal(s.bindings[i]);
        return;
      }
      case 'LocalFunction': {
        const { slot, boxed } = this.declare(s);
        if (boxed) {
          this.emit('NIL');
          this.emit('NEWBOX', { a: slot });
          this.closure(s.func, s.name);
          this.emit('SETBOX', { a: slot });
        } else {
          this.closure(s.func, s.name);
          this.emit('SETL', { a: slot });
        }
        return;
      }
      case 'Assign':
        this.assign(s.targets, s.values);
        return;
      case 'CompoundAssign':
        this.compound(s.target, s.op, s.value);
        return;
      case 'CallStat':
        this.call(s.call, 0);
        return;
      case 'Do':
        this.block(s.body);
        return;
      case 'While': {
        const top = this.here();
        this.expr(s.cond);
        const exit = this.emit('JF', { t: -1 });
        const loop: Loop = { breaks: [], continueTarget: [], continueLabel: top };
        this.fn.loops.push(loop);
        this.block(s.body);
        this.fn.loops.pop();
        this.emit('JMP', { t: top });
        this.patch(exit);
        for (const b of loop.breaks) this.patch(b);
        return;
      }
      case 'Repeat': {
        const top = this.here();
        const loop: Loop = { breaks: [], continueTarget: [] };
        this.fn.loops.push(loop);
        this.block(s.body);
        this.fn.loops.pop();
        // "continue" en repeat salta a la condición.
        for (const c of loop.continueTarget) this.patch(c);
        this.expr(s.cond);
        this.emit('JF', { t: top });
        for (const b of loop.breaks) this.patch(b);
        return;
      }
      case 'If': {
        const ends: number[] = [];
        for (const c of s.clauses) {
          this.expr(c.cond);
          const skip = this.emit('JF', { t: -1 });
          this.block(c.body);
          ends.push(this.emit('JMP', { t: -1 }));
          this.patch(skip);
        }
        if (s.elseBody) this.block(s.elseBody);
        for (const e of ends) this.patch(e);
        return;
      }
      case 'NumericFor':
        this.numericFor(s);
        return;
      case 'GenericFor':
        this.genericFor(s);
        return;
      case 'Function': {
        const t = s.target;
        if (t.kind === 'Index') {
          this.expr(t.object);
          this.emit('CONST', { a: this.constIndex((t.index as A.StringLit).value) });
          this.closure(s.func, s.target.kind === 'Index' ? (t.index as A.StringLit).value : '?');
          this.emit('SETI');
        } else {
          this.closure(s.func, t.name);
          this.storeName(t);
        }
        return;
      }
      case 'Return':
        this.returnStat(s.values);
        return;
      case 'Break': {
        const loop = this.fn.loops[this.fn.loops.length - 1];
        loop.breaks.push(this.emit('JMP', { t: -1 }));
        return;
      }
      case 'Continue': {
        const loop = this.fn.loops[this.fn.loops.length - 1];
        if (loop.continueLabel !== undefined) this.emit('JMP', { t: loop.continueLabel });
        else loop.continueTarget.push(this.emit('JMP', { t: -1 }));
        return;
      }
      case 'TypeAlias':
        return;
    }
  }

  private assign(targets: (A.NameExpr | A.IndexExpr)[], values: A.Expr[]): void {
    if (targets.length === 1 && values.length === 1) {
      const t = targets[0];
      if (t.kind === 'Index') {
        this.expr(t.object);
        this.expr(t.index);
        this.expr(values[0]);
        this.emit('SETI');
      } else {
        this.expr(values[0]);
        this.storeName(t);
      }
      return;
    }
    // Varias asignaciones: se evalúan todos los valores en temporales primero.
    this.exprListFixed(values, targets.length);
    const temps = targets.map(() => this.newSlot());
    for (let i = targets.length - 1; i >= 0; i--) this.emit('SETL', { a: temps[i] });
    targets.forEach((t, i) => {
      if (t.kind === 'Index') {
        this.expr(t.object);
        this.expr(t.index);
        this.emit('GETL', { a: temps[i] });
        this.emit('SETI');
      } else {
        this.emit('GETL', { a: temps[i] });
        this.storeName(t);
      }
    });
  }

  private compound(target: A.NameExpr | A.IndexExpr, op: string, value: A.Expr): void {
    const binop = BINOPS[op];
    if (target.kind === 'Name') {
      this.loadName(target);
      this.expr(value);
      this.emit(binop);
      this.storeName(target);
      return;
    }
    const objSlot = this.newSlot();
    const keySlot = this.newSlot();
    const valSlot = this.newSlot();
    this.expr(target.object);
    this.emit('SETL', { a: objSlot });
    this.expr(target.index);
    this.emit('SETL', { a: keySlot });
    this.emit('GETL', { a: objSlot });
    this.emit('GETL', { a: keySlot });
    this.emit('GETI');
    this.expr(value);
    this.emit(binop);
    this.emit('SETL', { a: valSlot });
    this.emit('GETL', { a: objSlot });
    this.emit('GETL', { a: keySlot });
    this.emit('GETL', { a: valSlot });
    this.emit('SETI');
  }

  private numericFor(s: A.NumericForStat): void {
    // Contador, límite y paso ocupan slots consecutivos: FORTEST/FORSTEP los leen como base, base+1, base+2.
    const counter = this.newSlot();
    const limit = this.newSlot();
    const step = this.newSlot();
    if (limit !== counter + 1 || step !== counter + 2) throw new SynexError('slots de bucle no consecutivos', this.fn.line, 0, 'E_INTERNAL');
    this.expr(s.start);
    this.emit('SETL', { a: counter });
    this.expr(s.limit);
    this.emit('SETL', { a: limit });
    if (s.step) this.expr(s.step);
    else this.emit('CONST', { a: this.constIndex(1) });
    this.emit('SETL', { a: step });

    const top = this.here();
    const exit = this.emit('FORTEST', { a: counter, t: -1 });
    // Cada iteración recibe su propia copia de la variable (importante si se captura).
    this.emit('GETL', { a: counter });
    this.initLocal(s.variable);
    const loop: Loop = { breaks: [], continueTarget: [] };
    this.fn.loops.push(loop);
    this.block(s.body);
    this.fn.loops.pop();
    const stepAt = this.here();
    for (const c of loop.continueTarget) this.patch(c, stepAt);
    this.emit('FORSTEP', { a: counter });
    this.emit('JMP', { t: top });
    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
  }

  private genericFor(s: A.GenericForStat): void {
    const base = this.newSlot();
    const sSlot = this.newSlot();
    const cSlot = this.newSlot();
    this.exprListFixed(s.exprs, 3);
    this.emit('SETL', { a: cSlot });
    this.emit('SETL', { a: sSlot });
    this.emit('SETL', { a: base });
    // Los tres slots deben ser consecutivos: base, sSlot, cSlot.
    if (sSlot !== base + 1 || cSlot !== base + 2) throw new SynexError('slots de bucle no consecutivos', this.fn.line, 0, 'E_INTERNAL');
    const top = this.here();
    const exit = this.emit('GENCALL', { a: base, b: s.bindings.length, t: -1 });
    for (let i = s.bindings.length - 1; i >= 0; i--) this.initLocal(s.bindings[i]);
    const loop: Loop = { breaks: [], continueTarget: [] };
    this.fn.loops.push(loop);
    this.block(s.body);
    this.fn.loops.pop();
    for (const c of loop.continueTarget) this.patch(c, top);
    this.emit('JMP', { t: top });
    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
  }

  private returnStat(values: A.Expr[]): void {
    if (values.length === 0) {
      this.emit('RET', { a: 0, c: false });
      return;
    }
    const last = values[values.length - 1];
    values.slice(0, -1).forEach((v) => this.expr(v));
    if (isMulti(last)) {
      this.multi(last);
      this.emit('RET', { a: values.length - 1, c: true });
    } else {
      this.expr(last);
      this.emit('RET', { a: values.length, c: false });
    }
  }

  // -------------------------------------------------------- nombres

  private loadName(n: A.NameExpr): void {
    const id = this.analysis.references.get(n)?.id;
    if (id === undefined) {
      this.emit('GETG', { a: this.constIndex(n.name) });
      return;
    }
    const slot = this.fn.slotOf.get(id);
    if (slot !== undefined) {
      this.emit(this.isBoxed(id) ? 'GETBOX' : 'GETL', { a: slot });
      return;
    }
    const up = this.resolveUpval(this.fn, id);
    if (up < 0) {
      this.emit('GETG', { a: this.constIndex(n.name) });
      return;
    }
    this.emit('GETUP', { a: up });
  }

  private storeName(n: A.NameExpr): void {
    const id = this.analysis.references.get(n)?.id;
    if (id === undefined) {
      this.emit('SETG', { a: this.constIndex(n.name) });
      return;
    }
    const slot = this.fn.slotOf.get(id);
    if (slot !== undefined) {
      this.emit(this.isBoxed(id) ? 'SETBOX' : 'SETL', { a: slot });
      return;
    }
    const up = this.resolveUpval(this.fn, id);
    if (up < 0) {
      this.emit('SETG', { a: this.constIndex(n.name) });
      return;
    }
    this.emit('SETUP', { a: up });
  }

  // -------------------------------------------------------- funciones

  private closure(func: A.FunctionBody, name: string): void {
    const child = new FnState(this.fn, name, func.params.length, func.isVararg);
    const saved = this.fn;
    this.fn = child;
    // Parámetros: los capturados se envuelven en celdas al entrar.
    for (const p of func.params) {
      const { slot, boxed } = this.declare(p);
      if (boxed) this.emit('BOXSLOT', { a: slot });
    }
    this.block(func.body);
    this.at({ line: func.endLine, column: 0 });
    this.emit('RET', { a: 0, c: false });
    this.fn = saved;
    saved.proto.protos.push(child.proto);
    this.emit('CLOSURE', { a: saved.proto.protos.length - 1 });
  }

  // -------------------------------------------------------- expresiones

  /** Emite exactamente `want` valores en la pila, ajustando la lista de expresiones. */
  private exprListFixed(exprs: A.Expr[], want: number): void {
    exprs.forEach((e, i) => {
      const isLast = i === exprs.length - 1;
      if (isLast && isMulti(e)) {
        this.multi(e);
        this.emit('ADJUST', { a: Math.max(0, want - i) });
        return;
      }
      this.expr(e);
      if (i >= want) this.emit('POP');
    });
    const n = exprs.length;
    if (n === 0 || !isMulti(exprs[n - 1])) {
      for (let i = n; i < want; i++) this.emit('NIL');
    }
  }

  /** Emite una expresión de valor múltiple (llamada o "...") dejando un Multi en la pila. */
  private multi(e: A.Expr): void {
    this.at(e);
    if (e.kind === 'Vararg') {
      this.emit('VARARG', { c: true });
      return;
    }
    this.call(e as A.CallExpr | A.MethodCallExpr, -1);
  }

  /** Llamada con nRes resultados (-1 = todos, dejando Multi). */
  private call(e: A.CallExpr | A.MethodCallExpr, nRes: number): void {
    this.at(e);
    let fixed = 0;
    if (e.kind === 'MethodCall') {
      this.expr(e.object);
      this.emit('SELF', { a: this.constIndex(e.method) });
      fixed = 1;
    } else {
      this.expr(e.callee);
    }
    const args = e.args;
    const last = args[args.length - 1];
    const multiTail = args.length > 0 && isMulti(last);
    const singles = multiTail ? args.slice(0, -1) : args;
    singles.forEach((a) => this.expr(a));
    if (multiTail) this.multi(last);
    this.at(e);
    this.emit('CALL', { a: fixed + singles.length, b: nRes, c: multiTail });
  }

  expr(e: A.Expr): void {
    this.at(e);
    switch (e.kind) {
      case 'Nil':
        this.emit('NIL');
        return;
      case 'Bool':
        this.emit(e.value ? 'TRUE' : 'FALSE');
        return;
      case 'Number':
        this.emit('CONST', { a: this.constIndex(Number(e.raw.replace(/_/g, ''))) });
        return;
      case 'String':
        this.emit('CONST', { a: this.constIndex(e.value) });
        return;
      case 'Vararg':
        this.emit('VARARG', { c: false });
        return;
      case 'Function':
        this.closure(e.func, 'anon');
        return;
      case 'Name':
        this.loadName(e);
        return;
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        this.emit('GETI');
        return;
      case 'Call':
      case 'MethodCall':
        this.call(e, 1);
        return;
      case 'Binary': {
        if (e.op === 'and' || e.op === 'or') {
          this.expr(e.left);
          const j = this.emit(e.op === 'and' ? 'JFK' : 'JTK', { t: -1 });
          this.expr(e.right);
          this.patch(j);
          return;
        }
        this.expr(e.left);
        this.expr(e.right);
        this.at(e);
        this.emit(BINOPS[e.op]);
        return;
      }
      case 'Unary':
        this.expr(e.operand);
        this.at(e);
        this.emit(e.op === 'not' ? 'NOT' : e.op === '-' ? 'NEG' : 'LEN');
        return;
      case 'Table':
        this.table(e);
        return;
      case 'Paren':
        this.expr(e.expr);
        return;
      case 'IfExpr': {
        this.expr(e.cond);
        let skip = this.emit('JF', { t: -1 });
        const ends: number[] = [];
        this.expr(e.then);
        ends.push(this.emit('JMP', { t: -1 }));
        this.patch(skip);
        for (const c of e.elseifs) {
          this.expr(c.cond);
          skip = this.emit('JF', { t: -1 });
          this.expr(c.then);
          ends.push(this.emit('JMP', { t: -1 }));
          this.patch(skip);
        }
        this.expr(e.else);
        for (const j of ends) this.patch(j);
        return;
      }
      case 'TypeAssert':
        this.expr(e.expr);
        return;
    }
  }

  private table(e: A.TableExpr): void {
    this.emit('NEWT');
    let n = 1;
    e.fields.forEach((f, i) => {
      if (f.kind === 'Positional') {
        const isLast = i === e.fields.length - 1;
        if (isLast && isMulti(f.value)) {
          this.multi(f.value);
          this.emit('TAPPENDM', { a: n });
        } else {
          this.expr(f.value);
          this.emit('TAPPEND', { a: n++ });
        }
      } else if (f.kind === 'Named') {
        this.emit('CONST', { a: this.constIndex(f.name) });
        this.expr(f.value);
        this.emit('SETT');
      } else {
        this.expr(f.key);
        this.expr(f.value);
        this.emit('SETT');
      }
    });
  }
}

const BINOPS: Record<string, Op> = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '//': 'IDIV', '%': 'MOD', '^': 'POW', '..': 'CONCAT',
  '==': 'EQ', '~=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
};

function isMulti(e: A.Expr): boolean {
  return e.kind === 'Call' || e.kind === 'MethodCall' || e.kind === 'Vararg';
}

/** Compila un AST (ya validado por el análisis semántico) a un prototipo de IR. */
export function compile(chunk: A.Chunk, analysis: AnalysisResult): Proto {
  return new Compiler(chunk, analysis).compileChunk();
}
