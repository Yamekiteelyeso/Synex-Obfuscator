import type * as A from '@synex/parser';
import { LuaError, LuaTable, NativeFunction, type Value } from './values.js';
import { numberToString, toNumber, typeName } from './interpreter.js';

/** Lo que la biblioteca necesita del entorno de ejecución (lo cumplen el intérprete y la VM). */
export interface LuaEnvironment {
  globals: LuaTable;
  output: string[];
  callValue(f: Value, args: Value[], at: A.Loc): Value[];
}

const at: A.Loc = { line: 0, column: 0 };

function tostring(v: Value): string {
  if (v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numberToString(v);
  if (typeof v === 'string') return v;
  return typeName(v) + ': builtin';
}

/** Biblioteca mínima de Luau usada por el intérprete de referencia. */
export function installStdlib(interp: LuaEnvironment): void {
  const call = (f: Value, args: Value[]): Value[] => interp.callValue(f, args, at);
  const g = interp.globals;
  const fn = (_name: string, f: (args: Value[]) => Value[]) => new NativeFunction(f);

  g.set('print', fn('print', (args) => {
    interp.output.push(args.map(tostring).join('\t'));
    return [];
  }));
  g.set('tostring', fn('tostring', (args) => [tostring(args[0])]));
  g.set('tonumber', fn('tonumber', (args) => {
    const v = args[0];
    if (typeof v === 'number') return [v];
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return [Number(v)];
    return [undefined];
  }));
  g.set('type', fn('type', (args) => [typeName(args[0])]));
  g.set('error', fn('error', (args) => {
    throw new LuaError(tostring(args[0]));
  }));
  g.set('pcall', fn('pcall', (args) => {
    try {
      return [true, ...call(args[0], args.slice(1))];
    } catch (e) {
      if (e instanceof LuaError) return [false, e.message];
      throw e;
    }
  }));
  g.set('select', fn('select', (args) => {
    const selector = args[0];
    const count = args.length - 1;
    if (selector === '#') return [count];
    const index = toNumber(selector, at);
    if (!Number.isInteger(index) || index === 0) {
      throw new LuaError("bad argument to select (index out of range)");
    }
    // Lua usa índices 1-based; los negativos cuentan desde el final.
    const start = index > 0 ? index : count + index + 1;
    if (start < 1) throw new LuaError("bad argument to select (index out of range)");
    return args.slice(start);
  }));

  const iterate = (t: LuaTable, keys: Value[]) => {
    let i = 0;
    return new NativeFunction(() => {
      while (i < keys.length) {
        const k = keys[i++];
        const v = t.get(k);
        if (v !== undefined) return [k, v];
      }
      return [undefined];
    });
  };

  g.set('pairs', fn('pairs', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError(`bad argument to pairs (table expected, got ${typeName(t)})`);
    return [iterate(t, [...t.hash.keys()]), t, undefined];
  }));
  g.set('ipairs', fn('ipairs', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError(`bad argument to ipairs (table expected, got ${typeName(t)})`);
    let i = 0;
    const it = new NativeFunction(() => {
      i++;
      const v = t.get(i);
      return v === undefined ? [undefined] : [i, v];
    });
    return [it, t, 0];
  }));

  const tableLib = new LuaTable();
  tableLib.set('concat', fn('concat', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.concat');
    const sep = args[1] === undefined ? '' : String(args[1]);
    const parts: string[] = [];
    for (let i = 1; i <= t.length(); i++) {
      const v = t.get(i);
      if (typeof v !== 'string' && typeof v !== 'number') throw new LuaError('invalid value in table for concat');
      parts.push(typeof v === 'number' ? numberToString(v) : v);
    }
    return [parts.join(sep)];
  }));
  tableLib.set('insert', fn('insert', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.insert');
    if (args.length >= 3) {
      const pos = toNumber(args[1], at);
      for (let i = t.length(); i >= pos; i--) t.set(i + 1, t.get(i));
      t.set(pos, args[2]);
    } else {
      t.set(t.length() + 1, args[1]);
    }
    return [];
  }));
  g.set('table', tableLib);

  const stringLib = new LuaTable();
  stringLib.set('char', fn('char', (args) =>
    [String.fromCharCode(...args.map((a) => toNumber(a, at) & 0xff))]));
  stringLib.set('len', fn('len', (args) => [String(args[0]).length]));
  stringLib.set('byte', fn('byte', (args) => {
    const s = String(args[0]);
    const i = args[1] === undefined ? 1 : toNumber(args[1], at);
    return [s.charCodeAt(i - 1)];
  }));
  g.set('string', stringLib);

  const bit = new LuaTable();
  const bitOp = (f: (a: number, b: number) => number) => fn('bit', (args) => {
    let acc = toNumber(args[0], at) >>> 0;
    for (let i = 1; i < args.length; i++) acc = f(acc, toNumber(args[i], at) >>> 0) >>> 0;
    return [acc];
  });
  bit.set('bxor', bitOp((a, b) => a ^ b));
  bit.set('band', bitOp((a, b) => a & b));
  bit.set('bor', bitOp((a, b) => a | b));
  g.set('bit32', bit);
}
