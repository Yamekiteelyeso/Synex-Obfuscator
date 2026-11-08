import { SynexError } from '@synex/shared';
import type { Op, Proto } from '@synex/ir';

/** Operaciones válidas del IR con los campos que deben ser índices válidos. */
const VALID_OPS = new Set<Op>([
  'CONST', 'NIL', 'TRUE', 'FALSE', 'POP', 'GETL', 'SETL', 'MOVE', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT',
  'GETUP', 'SETUP', 'GETG', 'SETG', 'GETI', 'SETI', 'SELF',
  'ADD', 'SUB', 'MUL', 'DIV', 'IDIV', 'MOD', 'POW', 'CONCAT', 'EQ', 'NE', 'LT', 'LE', 'GT', 'GE',
  'NEG', 'NOT', 'LEN', 'JMP', 'JF', 'JFK', 'JTK', 'FORTEST', 'FORSTEP', 'GENCALL',
  'CALL', 'RET', 'VARARG', 'ADJUST', 'CLOSURE', 'NEWT', 'SETT', 'TAPPEND', 'TAPPENDM',
]);

const JUMPS = new Set<Op>(['JMP', 'JF', 'JFK', 'JTK', 'FORTEST', 'GENCALL']);
const SLOT_OPS = new Set<Op>(['GETL', 'SETL', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT', 'FORTEST', 'FORSTEP', 'GENCALL']);
const CONST_OPS = new Set<Op>(['CONST', 'GETG', 'SETG', 'SELF']);

function fail(msg: string, proto: Proto, pc: number): never {
  throw new SynexError(`bytecode inválido en "${proto.name}" (instrucción ${pc + 1}): ${msg}`, 1, 1, 'E_BYTECODE');
}

/**
 * Valida un prototipo y sus hijos antes de emitirlo: operaciones conocidas,
 * saltos dentro del código, ranuras y upvalues dentro de rango y constantes
 * válidas. Un bytecode que pasa esta validación no puede hacer que la VM
 * lea posiciones inexistentes.
 */
export function validateProto(proto: Proto): void {
  if (proto.code.length === 0) fail('el prototipo no tiene instrucciones', proto, -1);
  if (!Number.isInteger(proto.nparams) || proto.nparams < 0) fail('número de parámetros inválido', proto, -1);
  if (!Number.isInteger(proto.nslots) || proto.nslots < proto.nparams) fail('número de ranuras inválido', proto, -1);
  proto.code.forEach((ins, pc) => {
    if (ins.op === 'MOVE' && (!Number.isInteger(ins.a) || !Number.isInteger(ins.b) || ins.a! < 0 || ins.a! >= proto.nslots || ins.b! < 0 || ins.b! >= proto.nslots)) fail('ranura MOVE fuera de rango', proto, pc);
    if (!VALID_OPS.has(ins.op)) fail(`operación desconocida ${String(ins.op)}`, proto, pc);
    if (JUMPS.has(ins.op)) {
      if (!Number.isInteger(ins.t) || ins.t! < 0 || ins.t! >= proto.code.length) fail('salto fuera del código', proto, pc);
    }
    if (SLOT_OPS.has(ins.op) && (!Number.isInteger(ins.a) || ins.a! < 0 || ins.a! >= proto.nslots)) {
      fail('ranura fuera de rango', proto, pc);
    }
    if (CONST_OPS.has(ins.op) && (!Number.isInteger(ins.a) || ins.a! < 0 || ins.a! >= proto.consts.length)) {
      fail('constante fuera de rango', proto, pc);
    }
    if ((ins.op === 'GETUP' || ins.op === 'SETUP') && (!Number.isInteger(ins.a) || ins.a! < 0 || ins.a! >= proto.upvals.length)) {
      fail('upvalue fuera de rango', proto, pc);
    }
    if (ins.op === 'CLOSURE' && (!Number.isInteger(ins.a) || ins.a! < 0 || ins.a! >= proto.protos.length)) {
      fail('función anidada fuera de rango', proto, pc);
    }
  });
  // Las capturas de cada hijo apuntan a ranuras o upvalues de este prototipo.
  proto.protos.forEach((child) => {
    child.upvals.forEach((d) => {
      if (d.fromLocal && (d.index < 0 || d.index >= proto.nslots)) fail('captura de ranura inválida', proto, -1);
      if (!d.fromLocal && (d.index < 0 || d.index >= proto.upvals.length)) fail('captura de upvalue inválida', proto, -1);
    });
    validateProto(child);
  });
}
