/**
 * Árbol sintáctico abstracto (AST) de Luau.
 * Todos los nodos llevan la posición de su primer token (line, column).
 */

export interface Loc {
  line: number;
  column: number;
}

// ---------------------------------------------------------------- Tipos

export type TypeNode =
  | TypeRef
  | TypeSingleton
  | TypeTable
  | TypeFunction
  | TypeUnion
  | TypeIntersection
  | TypeOptional
  | TypeTypeof
  | TypeGroup
  | TypePack;

export interface TypeRef extends Loc {
  kind: 'TypeRef';
  /** Nombre, posiblemente calificado ("Modulo.Tipo"). */
  name: string;
  args: TypeNode[];
}

export interface TypeSingleton extends Loc {
  kind: 'TypeSingleton';
  value: string | boolean;
}

export interface TypeTableProp {
  name: string;
  type: TypeNode;
}

export interface TypeIndexer {
  key: TypeNode;
  value: TypeNode;
}

export interface TypeTable extends Loc {
  kind: 'TypeTable';
  props: TypeTableProp[];
  indexers: TypeIndexer[];
}

export interface TypeParam {
  name: string | null;
  type: TypeNode;
}

export interface TypeFunction extends Loc {
  kind: 'TypeFunction';
  params: TypeParam[];
  returns: TypeNode[];
}

export interface TypeUnion extends Loc {
  kind: 'TypeUnion';
  types: TypeNode[];
}

export interface TypeIntersection extends Loc {
  kind: 'TypeIntersection';
  types: TypeNode[];
}

export interface TypeOptional extends Loc {
  kind: 'TypeOptional';
  type: TypeNode;
}

export interface TypeTypeof extends Loc {
  kind: 'TypeTypeof';
  expr: Expr;
}

export interface TypeGroup extends Loc {
  kind: 'TypeGroup';
  type: TypeNode;
}

/** Lista de tipos entre paréntesis sin "->": sólo válida como retorno múltiple. */
export interface TypePack extends Loc {
  kind: 'TypePack';
  types: TypeNode[];
}

// ---------------------------------------------------------- Expresiones

export type Expr =
  | NilLit
  | BoolLit
  | NumberLit
  | StringLit
  | VarargExpr
  | FunctionExpr
  | NameExpr
  | IndexExpr
  | CallExpr
  | MethodCallExpr
  | BinaryExpr
  | UnaryExpr
  | TableExpr
  | ParenExpr
  | IfExpr
  | TypeAssertExpr;

export interface NilLit extends Loc { kind: 'Nil' }
export interface BoolLit extends Loc { kind: 'Bool'; value: boolean }
export interface NumberLit extends Loc { kind: 'Number'; raw: string }
export interface StringLit extends Loc { kind: 'String'; value: string }
export interface VarargExpr extends Loc { kind: 'Vararg' }

export interface Param {
  name: string;
  type: TypeNode | null;
  /** Verdadero para el "self" implícito de las funciones con ":". */
  implicit: boolean;
}

export interface FunctionBody {
  generics: string[];
  params: Param[];
  isVararg: boolean;
  varargType: TypeNode | null;
  returnTypes: TypeNode[] | null;
  body: Stat[];
  endLine: number;
}

export interface FunctionExpr extends Loc {
  kind: 'Function';
  func: FunctionBody;
}

export interface NameExpr extends Loc {
  kind: 'Name';
  name: string;
}

export interface IndexExpr extends Loc {
  kind: 'Index';
  object: Expr;
  /** Expresión de la clave. Para "a.b" es un StringLit. */
  index: Expr;
  /** Verdadero si se escribió con punto ("a.b"). */
  dot: boolean;
}

export interface CallExpr extends Loc {
  kind: 'Call';
  callee: Expr;
  args: Expr[];
}

export interface MethodCallExpr extends Loc {
  kind: 'MethodCall';
  object: Expr;
  method: string;
  args: Expr[];
}

export interface BinaryExpr extends Loc {
  kind: 'Binary';
  op: string;
  left: Expr;
  right: Expr;
}

export interface UnaryExpr extends Loc {
  kind: 'Unary';
  op: 'not' | '-' | '#';
  operand: Expr;
}

export type TableField =
  | { kind: 'Positional'; value: Expr }
  | { kind: 'Named'; name: string; value: Expr }
  | { kind: 'Keyed'; key: Expr; value: Expr };

export interface TableExpr extends Loc {
  kind: 'Table';
  fields: TableField[];
}

export interface ParenExpr extends Loc {
  kind: 'Paren';
  expr: Expr;
}

export interface IfExpr extends Loc {
  kind: 'IfExpr';
  cond: Expr;
  then: Expr;
  elseifs: { cond: Expr; then: Expr }[];
  else: Expr;
}

export interface TypeAssertExpr extends Loc {
  kind: 'TypeAssert';
  expr: Expr;
  type: TypeNode;
}

// ------------------------------------------------------------ Sentencias

export interface Binding {
  name: string;
  type: TypeNode | null;
}

export type Stat =
  | LocalStat
  | LocalFunctionStat
  | AssignStat
  | CompoundAssignStat
  | CallStat
  | DoStat
  | WhileStat
  | RepeatStat
  | IfStat
  | NumericForStat
  | GenericForStat
  | FunctionStat
  | ReturnStat
  | BreakStat
  | ContinueStat
  | TypeAliasStat;

export interface LocalStat extends Loc {
  kind: 'Local';
  bindings: Binding[];
  values: Expr[];
}

export interface LocalFunctionStat extends Loc {
  kind: 'LocalFunction';
  name: string;
  func: FunctionBody;
}

export interface AssignStat extends Loc {
  kind: 'Assign';
  targets: (NameExpr | IndexExpr)[];
  values: Expr[];
}

export interface CompoundAssignStat extends Loc {
  kind: 'CompoundAssign';
  /** Operador binario subyacente: "+" para "+=", ".." para "..=", etc. */
  op: string;
  target: NameExpr | IndexExpr;
  value: Expr;
}

export interface CallStat extends Loc {
  kind: 'CallStat';
  call: CallExpr | MethodCallExpr;
}

export interface DoStat extends Loc {
  kind: 'Do';
  body: Stat[];
}

export interface WhileStat extends Loc {
  kind: 'While';
  cond: Expr;
  body: Stat[];
}

export interface RepeatStat extends Loc {
  kind: 'Repeat';
  body: Stat[];
  cond: Expr;
}

export interface IfClause {
  cond: Expr;
  body: Stat[];
}

export interface IfStat extends Loc {
  kind: 'If';
  clauses: IfClause[];
  elseBody: Stat[] | null;
}

export interface NumericForStat extends Loc {
  kind: 'NumericFor';
  variable: Binding;
  start: Expr;
  limit: Expr;
  step: Expr | null;
  body: Stat[];
}

export interface GenericForStat extends Loc {
  kind: 'GenericFor';
  bindings: Binding[];
  exprs: Expr[];
  body: Stat[];
}

export interface FunctionStat extends Loc {
  kind: 'Function';
  /** Destino: Name o Index encadenados ("a.b.c" o "a.b:c"). */
  target: NameExpr | IndexExpr;
  method: boolean;
  func: FunctionBody;
}

export interface ReturnStat extends Loc {
  kind: 'Return';
  values: Expr[];
}

export interface BreakStat extends Loc { kind: 'Break' }
export interface ContinueStat extends Loc { kind: 'Continue' }

export interface TypeAliasStat extends Loc {
  kind: 'TypeAlias';
  name: string;
  generics: string[];
  type: TypeNode;
  exported: boolean;
}

export interface Chunk extends Loc {
  kind: 'Chunk';
  body: Stat[];
}
