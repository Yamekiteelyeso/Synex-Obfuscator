import type { Value } from '@synex/runtime';

/**
 * Representación intermedia de Synex: bytecode de pila por función (prototipo).
 * Cada instrucción lleva su línea de origen para mensajes de error.
 *
 * Campos usados según la operación:
 *   a: operando principal (constante, slot, índice de upvalue, nº de argumentos fijos)
 *   b: segundo operando (nº de resultados, nº de variables, slot)
 *   c: tercer operando o bandera "multi" (valores variables al final de la pila)
 *   t: destino de salto (índice de instrucción)
 */
export type Op =
  | 'CONST' | 'NIL' | 'TRUE' | 'FALSE' | 'POP'
  | 'GETL' | 'SETL' | 'MOVE' | 'NEWBOX' | 'GETBOX' | 'SETBOX' | 'BOXSLOT'
  | 'GETUP' | 'SETUP'
  | 'GETG' | 'SETG'
  | 'GETI' | 'SETI' | 'SELF'
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'IDIV' | 'MOD' | 'POW' | 'CONCAT'
  | 'EQ' | 'NE' | 'LT' | 'LE' | 'GT' | 'GE'
  | 'NEG' | 'NOT' | 'LEN'
  | 'JMP' | 'JF' | 'JFK' | 'JTK'
  | 'FORTEST' | 'FORSTEP' | 'GENCALL'
  | 'CALL' | 'RET' | 'VARARG' | 'ADJUST'
  | 'CLOSURE' | 'NEWT' | 'SETT' | 'TAPPEND' | 'TAPPENDM';

export interface Instr {
  op: Op;
  a?: number;
  b?: number;
  c?: boolean;
  t?: number;
  line: number;
}

export interface UpvalDesc {
  /** true: capturado de un slot local del padre; false: upvalue del padre. */
  fromLocal: boolean;
  index: number;
}

export interface Proto {
  name: string;
  nparams: number;
  isVararg: boolean;
  nslots: number;
  code: Instr[];
  consts: Value[];
  protos: Proto[];
  upvals: UpvalDesc[];
}

/** Marcador en la pila: indica que los n valores inmediatamente debajo son un resultado múltiple. */
export class Multi {
  constructor(readonly n: number) {}
}
