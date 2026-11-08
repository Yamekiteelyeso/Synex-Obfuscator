import { SynexError } from '@synex/shared';
import type { Op, Proto } from '@synex/ir';

const VALID_OPS = new Set<Op>([
  'CONST', 'NIL', 'TRUE', 'FALSE', 'POP', 'GETL', 'SETL', 'MOVE', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT',
  'GETUP', 'SETUP', 'GETG', 'SETG', 'GETI', 'SETI', 'SELF',
  'ADD', 'SUB', 'MUL', 'DIV', 'IDIV', 'MOD', 'POW', 'CONCAT', 'EQ', 'NE', 'LT', 'LE', 'GT', 'GE',
  'NEG', 'NOT', 'LEN', 'JMP', 'JF', 'JFK', 'JTK', 'FORTEST', 'FORSTEP', 'GENCALL',
  'CALL', 'RET', 'VARARG', 'ADJUST', 'CLOSURE', 'NEWT', 'SETT', 'TAPPEND', 'TAPPENDM',
]);
const JUMPS = new Set<Op>(['JMP', 'JF', 'JFK', 'JTK', 'FORTEST', 'GENCALL']);
const SLOT = new Set<Op>(['GETL', 'SETL', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT']);
const CONST_NAME = new Set<Op>(['GETG', 'SETG', 'SELF']);
const MAX_PROTO_DEPTH = 512;
const MAX_CODE_LENGTH = 1_000_000;
const MAX_SLOTS = 1_000_000;

function fail(msg: string, proto: Proto, pc = -1): never {
  const name = typeof proto?.name === 'string' ? proto.name : '<unknown>';
  throw new SynexError(`bytecode inválido en "${name}" (instrucción ${pc + 1}): ${msg}`, 1, 1, 'E_BYTECODE');
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
function index(value: unknown, length: number): value is number {
  return integer(value) && value >= 0 && value < length;
}

/**
 * Valida de forma defensiva todo el árbol de prototipos antes de ejecutarlo o
 * emitirlo. Comprueba operandos por opcode, rangos, constantes y capturas.
 * Rechaza referencias cíclicas y estructuras excesivas para evitar DoS.
 */
export function validateProto(root: Proto): void {
  const visiting = new Set<object>();
  const visited = new Set<object>();

  const visit = (proto: Proto, parent: Proto | null, depth: number): void => {
    if (!proto || typeof proto !== 'object' || Array.isArray(proto)) {
      throw new SynexError('bytecode inválido: prototipo no es un objeto', 1, 1, 'E_BYTECODE');
    }
    if (depth > MAX_PROTO_DEPTH) fail('profundidad de prototipos excedida', proto);
    if (visiting.has(proto)) fail('ciclo en árbol de prototipos', proto);
    if (visited.has(proto)) fail('prototipo compartido entre varias posiciones', proto);
    visiting.add(proto);

    if (!Array.isArray(proto.code) || proto.code.length === 0 || proto.code.length > MAX_CODE_LENGTH) {
      fail('longitud de código inválida', proto);
    }
    if (!integer(proto.nparams) || proto.nparams < 0) fail('número de parámetros inválido', proto);
    if (!integer(proto.nslots) || proto.nslots < proto.nparams || proto.nslots > MAX_SLOTS) fail('número de ranuras inválido', proto);
    if (typeof proto.isVararg !== 'boolean') fail('bandera vararg inválida', proto);
    if (!Array.isArray(proto.consts) || !Array.isArray(proto.protos) || !Array.isArray(proto.upvals)) fail('tablas del prototipo inválidas', proto);
    if (proto.consts.length > MAX_CODE_LENGTH || proto.protos.length > MAX_CODE_LENGTH || proto.upvals.length > MAX_SLOTS) fail('tabla del prototipo demasiado grande', proto);

    proto.consts.forEach((value, i) => {
      const t = typeof value;
      if (!(value === undefined || value === null || t === 'string' || t === 'number' || t === 'boolean')) {
        fail(`tipo de constante no serializable en índice ${i}`, proto);
      }
    });

    proto.code.forEach((ins, pc) => {
      if (!ins || typeof ins !== 'object' || Array.isArray(ins)) fail('instrucción no es un objeto', proto, pc);
      if (!VALID_OPS.has(ins.op)) fail(`operación desconocida ${String(ins.op)}`, proto, pc);
      if (!integer(ins.line) || ins.line < 0) fail('número de línea inválido', proto, pc);
      for (const [field, value] of [['a', ins.a], ['b', ins.b], ['t', ins.t]] as const) {
        if (value !== undefined && !integer(value)) fail(`operando ${field} no es un entero seguro`, proto, pc);
      }
      if (ins.c !== undefined && typeof ins.c !== 'boolean') fail('bandera c inválida', proto, pc);
      if (ins.t !== undefined && !JUMPS.has(ins.op)) fail('destino de salto inesperado', proto, pc);
      if (ins.t !== undefined && !index(ins.t, proto.code.length)) fail('salto fuera del código', proto, pc);

      if (SLOT.has(ins.op) && !index(ins.a, proto.nslots)) fail('ranura fuera de rango', proto, pc);
      if (ins.op === 'MOVE' && (!index(ins.a, proto.nslots) || !index(ins.b, proto.nslots))) fail('ranura MOVE fuera de rango', proto, pc);
      if ((ins.op === 'FORTEST' || ins.op === 'FORSTEP' || ins.op === 'GENCALL')
        && (!integer(ins.a) || ins.a < 0 || ins.a + 2 >= proto.nslots)) fail('ranuras de iterador fuera de rango', proto, pc);
      if (ins.op === 'CONST' && !index(ins.a, proto.consts.length)) fail('constante fuera de rango', proto, pc);
      if (CONST_NAME.has(ins.op)) {
        if (!index(ins.a, proto.consts.length)) fail('constante fuera de rango', proto, pc);
        if (typeof proto.consts[ins.a] !== 'string') fail('nombre global/método no es una cadena', proto, pc);
      }
      if ((ins.op === 'GETUP' || ins.op === 'SETUP') && !index(ins.a, proto.upvals.length)) fail('upvalue fuera de rango', proto, pc);
      if (ins.op === 'CLOSURE' && !index(ins.a, proto.protos.length)) fail('función anidada fuera de rango', proto, pc);
      if ((ins.op === 'CALL' || ins.op === 'RET') && (!integer(ins.a) || ins.a < 0)) fail('cantidad de valores inválida', proto, pc);
      if (ins.op === 'CALL' && (!integer(ins.b) || ins.b < -1 || typeof ins.c !== 'boolean')) fail('descriptor CALL inválido', proto, pc);
      if (ins.op === 'RET' && typeof ins.c !== 'boolean') fail('descriptor RET inválido', proto, pc);
      if (ins.op === 'VARARG' && typeof ins.c !== 'boolean') fail('descriptor VARARG inválido', proto, pc);
      if (ins.op === 'ADJUST' && (!integer(ins.a) || ins.a < 0)) fail('cantidad ADJUST inválida', proto, pc);
      if (ins.op === 'GENCALL' && (!integer(ins.b) || ins.b < 0)) fail('cantidad GENCALL inválida', proto, pc);
      if ((ins.op === 'TAPPEND' || ins.op === 'TAPPENDM') && (!integer(ins.a) || ins.a < 1)) fail('índice de tabla inválido', proto, pc);
      if (ins.op === 'FORTEST' && !index(ins.t, proto.code.length)) fail('destino FORTEST inválido', proto, pc);
      if (ins.op === 'GENCALL' && !index(ins.t, proto.code.length)) fail('destino GENCALL inválido', proto, pc);
    });

    proto.upvals.forEach((d, i) => {
      if (!d || typeof d !== 'object' || typeof d.fromLocal !== 'boolean' || !integer(d.index) || d.index < 0) {
        fail(`descriptor de upvalue inválido en índice ${i}`, proto);
      }
      if (parent === null) fail('el prototipo raíz no puede tener upvalues capturados', proto);
      if (d.fromLocal && d.index >= parent!.nslots) fail('captura de ranura inválida', proto);
      if (!d.fromLocal && d.index >= parent!.upvals.length) fail('captura de upvalue inválida', proto);
    });

    proto.protos.forEach((child) => visit(child, proto, depth + 1));
    visiting.delete(proto);
    visited.add(proto);
  };

  visit(root, null, 0);
}
