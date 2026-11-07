import type * as A from '@synex/parser';

/** Símbolo declarado en el fuente (variable, parámetro, función local, variable de bucle). */
export interface Symbol {
  /** Identificador único dentro del análisis; base para el renombrado. */
  id: number;
  name: string;
  kind: 'local' | 'param' | 'self' | 'localFunction' | 'loopVar';
  line: number;
  column: number;
  /** Número de lecturas (referencias que no son asignaciones). */
  reads: number;
  /** Verdadero si se asigna después de su declaración. */
  reassigned: boolean;
  /** Nodo que contiene el nombre de la declaración; el renombrado lo reescribe en .name. */
  decl: { name: string };
}

export interface Diagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
  severity: 'error';
}

export interface AnalysisResult {
  symbols: Symbol[];
  /** Cada NameExpr que referencia una variable local apunta a su símbolo. */
  references: Map<A.NameExpr, Symbol>;
  /** Nombres usados sin declaración local (globales de Roblox/Luau). */
  globals: Set<string>;
  diagnostics: Diagnostic[];
}

class Scope {
  readonly vars = new Map<string, Symbol>();
  constructor(readonly parent: Scope | null) {}

  lookup(name: string): Symbol | null {
    for (let s: Scope | null = this; s; s = s.parent) {
      const sym = s.vars.get(name);
      if (sym) return sym;
    }
    return null;
  }
}

/**
 * Análisis semántico de Luau: resolución de ámbitos y validación de
 * construcciones que el parser acepta sintácticamente pero que no son válidas
 * (break/continue fuera de bucle, "..." fuera de una función vararg).
 */
class Analyzer {
  private scope = new Scope(null);
  private loopDepth = 0;
  private isVararg = false;
  private nextId = 1;
  readonly result: AnalysisResult = {
    symbols: [],
    references: new Map(),
    globals: new Set(),
    diagnostics: [],
  };

  run(chunk: A.Chunk): AnalysisResult {
    this.block(chunk.body, false);
    return this.result;
  }

  private error(code: string, message: string, loc: A.Loc): void {
    this.result.diagnostics.push({ code, message, line: loc.line, column: loc.column, severity: 'error' });
  }

  private declare(name: string, kind: Symbol["kind"], loc: A.Loc, decl: { name: string }): Symbol {
    const sym: Symbol = {
      id: this.nextId++,
      name,
      kind,
      line: loc.line,
      column: loc.column,
      reads: 0,
      reassigned: false,
      decl,
    };
    this.scope.vars.set(name, sym);
    this.result.symbols.push(sym);
    return sym;
  }

  private withScope(fn: () => void): void {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      fn();
    } finally {
      this.scope = saved;
    }
  }

  private block(stats: A.Stat[], newScope = true): void {
    if (newScope) this.withScope(() => stats.forEach((s) => this.stat(s)));
    else stats.forEach((s) => this.stat(s));
  }

  private loopBody(stats: A.Stat[]): void {
    this.loopDepth++;
    try {
      this.block(stats);
    } finally {
      this.loopDepth--;
    }
  }

  private stat(s: A.Stat): void {
    switch (s.kind) {
      case 'Local':
        s.values.forEach((e) => this.expr(e));
        for (const b of s.bindings) this.declare(b.name, "local", s, b);
        return;
      case 'LocalFunction':
        // La función local se ve dentro de su propio cuerpo (recursión).
        this.declare(s.name, "localFunction", s, s);
        this.functionBody(s.func);
        return;
      case 'Assign':
        s.values.forEach((e) => this.expr(e));
        s.targets.forEach((t) => this.target(t));
        return;
      case 'CompoundAssign':
        this.expr(s.value);
        this.target(s.target);
        // Un compuesto también lee la variable.
        this.expr(s.target);
        return;
      case 'CallStat':
        this.expr(s.call);
        return;
      case 'Do':
        this.block(s.body);
        return;
      case 'While':
        this.expr(s.cond);
        this.loopBody(s.body);
        return;
      case 'Repeat':
        // La condición de "until" ve las variables del cuerpo.
        this.loopDepth++;
        this.withScope(() => {
          s.body.forEach((st) => this.stat(st));
          this.expr(s.cond);
        });
        this.loopDepth--;
        return;
      case 'If':
        for (const c of s.clauses) {
          this.expr(c.cond);
          this.block(c.body);
        }
        if (s.elseBody) this.block(s.elseBody);
        return;
      case 'NumericFor':
        this.expr(s.start);
        this.expr(s.limit);
        if (s.step) this.expr(s.step);
        this.withScope(() => {
          this.declare(s.variable.name, "loopVar", s, s.variable);
          this.loopBody(s.body);
        });
        return;
      case 'GenericFor':
        s.exprs.forEach((e) => this.expr(e));
        this.withScope(() => {
          for (const b of s.bindings) this.declare(b.name, "loopVar", s, b);
          this.loopBody(s.body);
        });
        return;
      case 'Function':
        this.target(s.target);
        this.functionBody(s.func);
        return;
      case 'Return':
        s.values.forEach((e) => this.expr(e));
        return;
      case 'Break':
        if (this.loopDepth === 0) this.error('E_BREAK_OUTSIDE_LOOP', "'break' fuera de un bucle", s);
        return;
      case 'Continue':
        if (this.loopDepth === 0) this.error('E_CONTINUE_OUTSIDE_LOOP', "'continue' fuera de un bucle", s);
        return;
      case 'TypeAlias':
        return;
    }
  }

  /** Destino de asignación: marca variables reasignadas y visita índices. */
  private target(t: A.NameExpr | A.IndexExpr): void {
    if (t.kind === 'Name') {
      const sym = this.scope.lookup(t.name);
      if (sym) {
        sym.reassigned = true;
        this.result.references.set(t, sym);
      } else {
        this.result.globals.add(t.name);
      }
      return;
    }
    this.expr(t.object);
    this.expr(t.index);
  }

  private functionBody(f: A.FunctionBody): void {
    const savedLoop = this.loopDepth;
    const savedVararg = this.isVararg;
    this.loopDepth = 0;
    this.isVararg = f.isVararg;
    this.withScope(() => {
      for (const p of f.params) this.declare(p.name, p.implicit ? "self" : "param", f.body[0] ?? { line: 0, column: 0 }, p);
      this.block(f.body, false);
    });
    this.loopDepth = savedLoop;
    this.isVararg = savedVararg;
  }

  private expr(e: A.Expr): void {
    switch (e.kind) {
      case 'Nil':
      case 'Bool':
      case 'Number':
      case 'String':
        return;
      case 'Vararg':
        if (!this.isVararg) this.error('E_VARARG_OUTSIDE', "'...' fuera de una función vararg", e);
        return;
      case 'Function':
        this.functionBody(e.func);
        return;
      case 'Name': {
        const sym = this.scope.lookup(e.name);
        if (sym) {
          sym.reads++;
          this.result.references.set(e, sym);
        } else {
          this.result.globals.add(e.name);
        }
        return;
      }
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        return;
      case 'Call':
        this.expr(e.callee);
        e.args.forEach((a) => this.expr(a));
        return;
      case 'MethodCall':
        this.expr(e.object);
        e.args.forEach((a) => this.expr(a));
        return;
      case 'Binary':
        this.expr(e.left);
        this.expr(e.right);
        return;
      case 'Unary':
        this.expr(e.operand);
        return;
      case 'Table':
        for (const f of e.fields) {
          if (f.kind === 'Keyed') this.expr(f.key);
          this.expr(f.value);
        }
        return;
      case 'Paren':
        this.expr(e.expr);
        return;
      case 'IfExpr':
        this.expr(e.cond);
        this.expr(e.then);
        for (const c of e.elseifs) {
          this.expr(c.cond);
          this.expr(c.then);
        }
        this.expr(e.else);
        return;
      case 'TypeAssert':
        this.expr(e.expr);
        return;
    }
  }
}

/** Ejecuta el análisis semántico sobre un AST ya construido. */
export function analyze(chunk: A.Chunk): AnalysisResult {
  return new Analyzer().run(chunk);
}
