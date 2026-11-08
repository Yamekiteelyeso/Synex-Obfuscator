import { SynexError } from '@synex/shared';
import {
  LuaError, LuaFunction, LuaTable, NativeFunction, installStdlib, numberToString, toNumber, toStr,
  truthy, typeName, type LuaEnvironment, type Value,
} from '@synex/runtime';
import { Multi, type Instr, type Proto } from '@synex/ir';

/** Celda compartida por closures para un local capturado. */
export interface Cell { v: Value }

type Slot = Value | Cell;
type Item = Value | Multi;

/** Función Luau compilada: prototipo + upvalues capturados. */
export class VmClosure extends LuaFunction {
  constructor(
    readonly proto: Proto,
    readonly upvals: Cell[],
    private readonly vm: VM,
  ) {
    super();
  }

  call(args: Value[]): Value[] {
    return this.vm.run(this.proto, this.upvals, args);
  }
}

/**
 * Máquina virtual de pila para el IR de Synex.
 * Ejecuta prototipos generados por el compilador. Usa la misma biblioteca y
 * los mismos valores que el intérprete de referencia, de modo que ambos son
 * comparables en las pruebas de equivalencia.
 */
export class VM implements LuaEnvironment {
  readonly globals = new LuaTable();
  readonly output: string[] = [];
  private depth = 0;
  private steps = 0;
  private stepLimit = Infinity;

  constructor(options: { stepLimit?: number } = {}) {
    this.stepLimit = options.stepLimit ?? 5_000_000;
    installStdlib(this);
  }

  /** Ejecuta el prototipo principal y devuelve sus resultados. */
  execute(main: Proto): Value[] {
    return this.run(main, [], []);
  }

  callValue(f: Value, args: Value[], at: { line: number; column: number }): Value[] {
    if (f instanceof LuaFunction) return f.call(args);
    throw new LuaError(`attempt to call ${typeName(f)} value`, at.line, at.column);
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new LuaError('límite de ejecución superado');
  }

  run(proto: Proto, upvals: Cell[], args: Value[]): Value[] {
    if (++this.depth > 200) {
      this.depth--;
      throw new LuaError('stack overflow');
    }
    try {
      return this.loop(proto, upvals, args);
    } finally {
      this.depth--;
    }
  }

  private loop(proto: Proto, upvals: Cell[], args: Value[]): Value[] {
    const slots: Slot[] = new Array(proto.nslots).fill(undefined);
    for (let i = 0; i < proto.nparams; i++) slots[i] = args[i];
    const varargs = proto.isVararg ? args.slice(proto.nparams) : [];
    const stack: Item[] = [];
    const code = proto.code;
    let pc = 0;
    let line = 0;

    const pop = (): Item => {
      const v = stack.pop();
      return v as Item;
    };
    const popValue = (): Value => {
      const v = stack.pop();
      if (v instanceof Multi) throw new SynexError('pila inconsistente', line, 0, 'E_INTERNAL');
      return v as Value;
    };
    const popMulti = (): Value[] => {
      const m = stack.pop();
      if (!(m instanceof Multi)) throw new SynexError('se esperaba un marcador de resultados múltiples', line, 0, 'E_INTERNAL');
      return stack.splice(stack.length - m.n, m.n) as Value[];
    };

    for (;;) {
      const ins: Instr = code[pc++];
      line = ins.line;
      this.tick();
      switch (ins.op) {
        case 'CONST': stack.push(proto.consts[ins.a!]); break;
        case 'NIL': stack.push(undefined); break;
        case 'TRUE': stack.push(true); break;
        case 'FALSE': stack.push(false); break;
        case 'POP': pop(); break;

        case 'GETL': stack.push(slots[ins.a!] as Value); break;
        case 'SETL': slots[ins.a!] = popValue(); break;
        // Superinstrucción fusionada: copia directa entre slots no capturados.
        case 'MOVE': slots[ins.b!] = slots[ins.a!]; break;
        case 'NEWBOX': slots[ins.a!] = { v: popValue() } as Cell; break;
        case 'BOXSLOT': slots[ins.a!] = { v: slots[ins.a!] as Value } as Cell; break;
        case 'GETBOX': stack.push((slots[ins.a!] as Cell).v); break;
        case 'SETBOX': (slots[ins.a!] as Cell).v = popValue(); break;
        case 'GETUP': stack.push(upvals[ins.a!].v); break;
        case 'SETUP': upvals[ins.a!].v = popValue(); break;
        case 'GETG': stack.push(this.globals.get(proto.consts[ins.a!] as string)); break;
        case 'SETG': this.globals.set(proto.consts[ins.a!] as string, popValue()); break;

        case 'GETI': {
          const key = popValue();
          const obj = popValue();
          stack.push(this.index(obj, key, line));
          break;
        }
        case 'SETI': {
          const v = popValue();
          const key = popValue();
          const obj = popValue();
          if (!(obj instanceof LuaTable)) throw new LuaError(`attempt to index ${typeName(obj)} value`, line, 0);
          obj.set(key, v);
          break;
        }
        case 'SELF': {
          const obj = popValue();
          stack.push(this.index(obj, proto.consts[ins.a!], line));
          stack.push(obj);
          break;
        }

        case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'IDIV': case 'MOD': case 'POW':
        case 'CONCAT': case 'EQ': case 'NE': case 'LT': case 'LE': case 'GT': case 'GE': {
          const b = popValue();
          const a = popValue();
          stack.push(binary(ins.op, a, b, line));
          break;
        }
        case 'NEG': stack.push(-toNumber(popValue(), { line, column: 0 })); break;
        case 'NOT': stack.push(!truthy(popValue())); break;
        case 'LEN': {
          const v = popValue();
          if (typeof v === 'string') stack.push(v.length);
          else if (v instanceof LuaTable) stack.push(v.length());
          else throw new LuaError(`attempt to get length of ${typeName(v)} value`, line, 0);
          break;
        }

        case 'JMP': pc = ins.t!; break;
        case 'JF': if (!truthy(popValue())) pc = ins.t!; break;
        case 'JFK': if (!truthy(stack[stack.length - 1] as Value)) pc = ins.t!; else pop(); break;
        case 'JTK': if (truthy(stack[stack.length - 1] as Value)) pc = ins.t!; else pop(); break;

        case 'FORTEST': {
          const base = ins.a!;
          const i = slots[base] as number;
          const limit = slots[base + 1] as number;
          const step = slots[base + 2] as number;
          if (!(step > 0 ? i <= limit : i >= limit)) pc = ins.t!;
          break;
        }
        case 'FORSTEP': {
          const base = ins.a!;
          slots[base] = (slots[base] as number) + (slots[base + 2] as number);
          break;
        }
        case 'GENCALL': {
          const base = ins.a!;
          const nvars = ins.b!;
          const f = slots[base] as Value;
          const res = this.callValue(f, [slots[base + 1] as Value, slots[base + 2] as Value], { line, column: 0 });
          if (res[0] === undefined) {
            pc = ins.t!;
            break;
          }
          slots[base + 2] = res[0];
          for (let k = 0; k < nvars; k++) stack.push(res[k]);
          break;
        }

        case 'CALL': {
          const nFixed = ins.a!;
          let args: Value[];
          if (ins.c) {
            const extra = popMulti();
            const fixed = stack.splice(stack.length - nFixed, nFixed) as Value[];
            args = fixed.concat(extra);
          } else {
            args = stack.splice(stack.length - nFixed, nFixed) as Value[];
          }
          const f = popValue();
          const results = this.callValue(f, args, { line, column: 0 });
          const want = ins.b!;
          if (want < 0) {
            for (const r of results) stack.push(r);
            stack.push(new Multi(results.length));
          } else {
            for (let k = 0; k < want; k++) stack.push(results[k]);
          }
          break;
        }
        case 'RET': {
          const nFixed = ins.a!;
          if (ins.c) {
            const extra = popMulti();
            const fixed = stack.splice(stack.length - nFixed, nFixed) as Value[];
            return fixed.concat(extra);
          }
          return stack.splice(stack.length - nFixed, nFixed) as Value[];
        }
        case 'VARARG': {
          if (ins.c) {
            for (const v of varargs) stack.push(v);
            stack.push(new Multi(varargs.length));
          } else {
            stack.push(varargs[0]);
          }
          break;
        }
        case 'ADJUST': {
          const want = ins.a!;
          const extra = popMulti();
          for (let k = 0; k < want; k++) stack.push(extra[k]);
          break;
        }

        case 'CLOSURE': {
          const child = proto.protos[ins.a!];
          const cells = child.upvals.map((d) =>
            d.fromLocal ? (slots[d.index] as Cell) : upvals[d.index]);
          stack.push(new VmClosure(child, cells, this));
          break;
        }
        case 'NEWT': stack.push(new LuaTable()); break;
        case 'SETT': {
          const v = popValue();
          const key = popValue();
          const t = stack[stack.length - 1] as LuaTable;
          t.set(key, v);
          break;
        }
        case 'TAPPEND': {
          const v = popValue();
          const t = stack[stack.length - 1] as LuaTable;
          t.set(ins.a!, v);
          break;
        }
        case 'TAPPENDM': {
          const extra = popMulti();
          const t = stack[stack.length - 1] as LuaTable;
          extra.forEach((v, k) => t.set(ins.a! + k, v));
          break;
        }
        default:
          throw new SynexError(`operación desconocida ${ins.op}`, line, 0, 'E_INTERNAL');
      }
    }
  }

  private index(obj: Value, key: Value, line: number): Value {
    if (obj instanceof LuaTable) return obj.get(key);
    if (typeof obj === 'string') {
      const lib = this.globals.get('string');
      return lib instanceof LuaTable ? lib.get(key) : undefined;
    }
    throw new LuaError(`attempt to index ${typeName(obj)} value`, line, 0);
  }
}

function binary(op: string, a: Value, b: Value, line: number): Value {
  const at = { line, column: 0 };
  switch (op) {
    case 'ADD': return toNumber(a, at) + toNumber(b, at);
    case 'SUB': return toNumber(a, at) - toNumber(b, at);
    case 'MUL': return toNumber(a, at) * toNumber(b, at);
    case 'DIV': return toNumber(a, at) / toNumber(b, at);
    case 'IDIV': return Math.floor(toNumber(a, at) / toNumber(b, at));
    case 'MOD': {
      const x = toNumber(a, at), y = toNumber(b, at);
      return x - Math.floor(x / y) * y;
    }
    case 'POW': return Math.pow(toNumber(a, at), toNumber(b, at));
    case 'CONCAT': return toStr(a, at) + toStr(b, at);
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'LT': return cmp(a, b, at, (x, y) => x < y);
    case 'LE': return cmp(a, b, at, (x, y) => x <= y);
    case 'GT': return cmp(b, a, at, (x, y) => x < y);
    case 'GE': return cmp(b, a, at, (x, y) => x <= y);
    default: throw new SynexError(`operador desconocido ${op}`, line, 0, 'E_INTERNAL');
  }
}

function cmp(a: Value, b: Value, at: { line: number; column: number }, f: (x: number | string, y: number | string) => boolean): boolean {
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) return f(a, b);
  throw new LuaError(`attempt to compare ${typeName(a)} with ${typeName(b)}`, at.line, at.column);
}

export { numberToString, NativeFunction };
