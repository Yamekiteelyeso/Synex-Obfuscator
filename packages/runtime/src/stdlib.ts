import type * as A from '@synex/parser';
import { LuaError, LuaTable, LuaFunction, NativeFunction, type Value } from './values.js';
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
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.concat (table expected)');
    const sep = args[1] === undefined ? '' : String(args[1]);
    const first = args[2] === undefined ? 1 : toNumber(args[2], at);
    const last = args[3] === undefined ? t.length() : toNumber(args[3], at);
    if (!Number.isInteger(first) || !Number.isInteger(last)) throw new LuaError('bad argument to table.concat (integer index expected)');
    const parts: string[] = [];
    for (let i = first; i <= last; i++) {
      const v = t.get(i);
      if (typeof v !== 'string' && typeof v !== 'number') throw new LuaError('invalid value in table for concat');
      parts.push(typeof v === 'number' ? numberToString(v) : v);
    }
    return [parts.join(sep)];
  }));
  tableLib.set('pack', fn('pack', (args) => {
    const packed = new LuaTable();
    for (let index = 0; index < args.length; index++) packed.set(index + 1, args[index]);
    packed.set('n', args.length);
    return [packed];
  }));
  const unpack = fn('unpack', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.unpack (table expected)');
    const first = args[1] === undefined ? 1 : toNumber(args[1], at);
    const last = args[2] === undefined ? t.length() : toNumber(args[2], at);
    if (!Number.isInteger(first) || !Number.isInteger(last)) {
      throw new LuaError('bad argument to table.unpack (integer index expected)');
    }
    if (last < first) return [];
    if (last - first + 1 > 1_000_000) throw new LuaError('table.unpack result too large');
    const result: Value[] = [];
    for (let i = first; i <= last; i++) result.push(t.get(i));
    return result;
  });
  tableLib.set('unpack', unpack);
  g.set('unpack', unpack);
  tableLib.set('remove', fn('remove', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.remove (table expected)');
    const length = t.length();
    const pos = args[1] === undefined ? length : toNumber(args[1], at);
    if (!Number.isInteger(pos)) throw new LuaError('bad argument to table.remove (integer index expected)');
    if (pos < 1 || pos > length) return [undefined];
    const removed = t.get(pos);
    for (let i = pos; i < length; i++) t.set(i, t.get(i + 1));
    t.set(length, undefined);
    return [removed];
  }));
  tableLib.set('insert', fn('insert', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.insert');
    const length = t.length();
    if (args.length !== 2 && args.length !== 3) throw new LuaError('wrong number of arguments to table.insert');
    if (args[args.length - 1] === undefined) throw new LuaError('bad argument to table.insert (value expected)');
    if (args.length === 3) {
      const pos = toNumber(args[1], at);
      if (!Number.isInteger(pos) || pos < 1 || pos > length + 1) throw new LuaError('bad argument to table.insert (position out of bounds)');
      for (let i = length; i >= pos; i--) t.set(i + 1, t.get(i));
      t.set(pos, args[2]);
    } else {
      t.set(length + 1, args[1]);
    }
    return [];
  }));
  tableLib.set('move', fn('move', (args) => {
    const source = args[0];
    const first = toNumber(args[1], at);
    const last = toNumber(args[2], at);
    const target = args[3] === undefined ? first : toNumber(args[3], at);
    const destination = args[4] === undefined ? source : args[4];
    if (!(source instanceof LuaTable) || !(destination instanceof LuaTable)) {
      throw new LuaError('bad argument to table.move (table expected)');
    }
    if (![first, last, target].every(Number.isSafeInteger)) {
      throw new LuaError('bad argument to table.move (integer index expected)');
    }
    if (last < first) return [destination];
    const count = last - first + 1;
    if (!Number.isSafeInteger(count) || count > 1_000_000
      || !Number.isSafeInteger(target + count - 1)) {
      throw new LuaError('table.move range too large');
    }
    if (source === destination && target > first && target <= last) {
      for (let i = count - 1; i >= 0; i--) destination.set(target + i, source.get(first + i));
    } else {
      for (let i = 0; i < count; i++) destination.set(target + i, source.get(first + i));
    }
    return [destination];
  }));
  tableLib.set('create', fn('create', (args) => {
    const size = args[0] === undefined ? 0 : toNumber(args[0], at);
    if (!Number.isSafeInteger(size) || size < 0 || size > 1_000_000) {
      throw new LuaError('bad argument to table.create (invalid size)');
    }
    const table = new LuaTable();
    if (args[1] !== undefined) {
      for (let index = 1; index <= size; index++) table.set(index, args[1]);
    }
    return [table];
  }));
  tableLib.set('find', fn('find', (args) => {
    const table = args[0];
    if (!(table instanceof LuaTable)) throw new LuaError('bad argument to table.find (table expected)');
    const start = args[2] === undefined ? 1 : toNumber(args[2], at);
    if (!Number.isSafeInteger(start)) throw new LuaError('bad argument to table.find (integer index expected)');
    for (let index = Math.max(1, start); index <= table.length(); index++) {
      if (table.get(index) === args[1]) return [index];
    }
    return [undefined];
  }));
  tableLib.set('clear', fn('clear', (args) => {
    const table = args[0];
    if (!(table instanceof LuaTable)) throw new LuaError('bad argument to table.clear (table expected)');
    table.hash.clear();
    return [];
  }));
  tableLib.set('clone', fn('clone', (args) => {
    const source = args[0];
    if (!(source instanceof LuaTable)) throw new LuaError('bad argument to table.clone (table expected)');
    const clone = new LuaTable();
    for (const [key, value] of source.hash) clone.set(key, value);
    return [clone];
  }));
  tableLib.set('sort', fn('sort', (args) => {
    const t = args[0];
    if (!(t instanceof LuaTable)) throw new LuaError('bad argument to table.sort (table expected)');
    const length = t.length();
    const values: Value[] = [];
    for (let i = 1; i <= length; i++) values.push(t.get(i));
    const comparator = args[1];
    if (comparator !== undefined && !(comparator instanceof LuaFunction)) {
      throw new LuaError('bad argument to table.sort (function expected)');
    }
    values.sort((a, b) => {
      if (comparator !== undefined) {
        const abResult = call(comparator, [a, b])[0];
        const ab = abResult !== undefined && abResult !== false;
        const baResult = call(comparator, [b, a])[0];
        const ba = baResult !== undefined && baResult !== false;
        if (ab && ba) throw new LuaError('invalid order function for sorting');
        return ab ? -1 : ba ? 1 : 0;
      }
      if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
      if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
      throw new LuaError('attempt to compare ' + typeName(a) + ' with ' + typeName(b));
    });
    for (let i = 0; i < values.length; i++) t.set(i + 1, values[i]);
    return [];
  }));
  g.set('table', tableLib);

  const stringLib = new LuaTable();
  stringLib.set('char', fn('char', (args) => {
    const bytes = args.map((value) => {
      const byte = toNumber(value, at);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new LuaError('bad argument to string.char (value out of range)');
      }
      return byte;
    });
    return [String.fromCharCode(...bytes)];
  }));
  stringLib.set('find', fn('find', (args) => {
    const source = String(args[0]);
    const pattern = String(args[1]);
    const init = args[2] === undefined ? 1 : toNumber(args[2], at);
    const plain = args[3] === true;
    if (!Number.isSafeInteger(init)) throw new LuaError('bad argument to string.find (integer index expected)');
    if (!plain) throw new LuaError('string.find: Lua pattern matching is not implemented; pass true for plain search');
    const start = init < 0 ? Math.max(source.length + init + 1, 1) : init;
    if (start < 1 || start > source.length + 1) return [undefined];
    const index = source.indexOf(pattern, start - 1);
    return index < 0 ? [undefined] : [index + 1, index + pattern.length];
  }));
  stringLib.set('format', fn('format', (args) => {
    const template = String(args[0]);
    let argument = 1;
    let output = '';
    const quote = (value: string) => '"' + value.replace(/[\\"\\x00-\\x1f\\x7f]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (ch === '"') return '\\"';
      if (ch === '\\\\') return '\\\\\\\\';
      if (ch === '\\n') return '\\\\n';
      if (ch === '\\r') return '\\\\r';
      if (ch === '\\t') return '\\\\t';
      return '\\\\' + String(code).padStart(3, '0');
    }) + '"';
    for (let index = 0; index < template.length; index++) {
      if (template[index] !== '%') { output += template[index]; continue; }
      if (template[index + 1] === '%') { output += '%'; index++; continue; }
      const match = /^%([-+ #0]*)(\\d*)(?:\\.(\\d+))?([cdiuoxXfFeEgGqs])/.exec(template.slice(index));
      if (!match) throw new LuaError('invalid format specifier near ' + template.slice(index, index + 8));
      const [, flags, widthText, precisionText, spec] = match;
      const width = widthText ? Number(widthText) : 0;
      const precision = precisionText === undefined ? undefined : Number(precisionText);
      if (width > 100_000 || (precision ?? 0) > 1000) throw new LuaError('string.format field width or precision too large');
      const value = args[argument++];
      if (value === undefined) throw new LuaError('bad argument to string.format (no value)');
      let rendered: string;
      if (spec === 's') {
        if (typeof value !== 'string') throw new LuaError('bad argument to string.format (%s expected)');
        rendered = precision === undefined ? value : value.slice(0, precision);
      } else if (spec === 'q') {
        rendered = quote(tostring(value));
      } else if (spec === 'c') {
        const byte = toNumber(value, at);
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new LuaError('bad argument to string.format (%c value out of range)');
        rendered = String.fromCharCode(byte);
      } else {
        const number = toNumber(value, at);
        if (!Number.isFinite(number) && 'diuoxX'.includes(spec)) throw new LuaError('bad argument to string.format (integer expected)');
        if ('diuoxX'.includes(spec)) {
          if (!Number.isSafeInteger(number)) throw new LuaError('bad argument to string.format (integer expected)');
          const integer = spec === 'u' ? number >>> 0 : number;
          const radix = spec === 'o' ? 8 : spec === 'x' || spec === 'X' ? 16 : 10;
          rendered = Math.abs(integer).toString(radix);
          if (spec === 'X') rendered = rendered.toUpperCase();
          if (integer < 0 && spec !== 'u') rendered = '-' + rendered;
          else if (flags.includes('+')) rendered = '+' + rendered;
          else if (flags.includes(' ') && integer >= 0) rendered = ' ' + rendered;
          if (flags.includes('#') && radix !== 10) rendered = (radix === 8 ? '0' : spec === 'X' ? '0X' : '0x') + rendered;
        } else {
          const digits = precision ?? 6;
          if (spec === 'f' || spec === 'F') rendered = number.toFixed(digits);
          else if (spec === 'e' || spec === 'E') rendered = number.toExponential(digits);
          else {
            rendered = digits === 0 ? number.toPrecision(1) : number.toPrecision(digits);
            if (!flags.includes('#') && rendered.includes('.')) rendered = rendered.replace(/(?:\\.0+|(?:(\\.\\d*?)0+))([eE]|$)/, '$1$2').replace(/\\.([eE]|$)/, '$1');
          }
          if (spec === 'E' || spec === 'G') rendered = rendered.toUpperCase();
          if (number >= 0 && flags.includes('+')) rendered = '+' + rendered;
          else if (number >= 0 && flags.includes(' ')) rendered = ' ' + rendered;
        }
      }
      const left = flags.includes('-');
      if (rendered.length < width) {
        const pad = (flags.includes('0') && !left ? '0' : ' ').repeat(width - rendered.length);
        if (left) rendered += pad;
        else if (pad[0] === '0' && /^[+-]/.test(rendered)) rendered = rendered[0] + pad + rendered.slice(1);
        else rendered = pad + rendered;
      }
      output += rendered;
      index += match[0].length - 1;
    }
    if (argument < args.length) throw new LuaError('string.format: too many arguments');
    return [output];
  }));
  stringLib.set('len', fn('len', (args) => [String(args[0]).length]));
  stringLib.set('lower', fn('lower', (args) => [String(args[0]).replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))]));
  stringLib.set('upper', fn('upper', (args) => [String(args[0]).replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32))]));
  stringLib.set('reverse', fn('reverse', (args) => [String(args[0]).split('').reverse().join('')]));
  stringLib.set('split', fn('split', (args) => {
    const input = String(args[0]);
    const separator = String(args[1]);
    if (separator === '') {
      const result = new LuaTable();
      for (let index = 0; index < input.length; index++) result.set(index + 1, input[index]);
      return [result];
    }
    const parts = input.split(separator);
    const result = new LuaTable();
    for (let index = 0; index < parts.length; index++) result.set(index + 1, parts[index]);
    return [result];
  }));


  stringLib.set('byte', fn('byte', (args) => {
    const s = String(args[0]);
    const length = s.length;
    const normalize = (index: number, isLast: boolean) =>
      index < 0 ? Math.max(length + index + 1, 1) : isLast ? Math.min(index, length) : index;
    const first = normalize(args[1] === undefined ? 1 : toNumber(args[1], at), false);
    const last = normalize(args[2] === undefined ? first : toNumber(args[2], at), true);
    if (!Number.isInteger(first) || !Number.isInteger(last)) throw new LuaError('bad argument to string.byte (integer index expected)');
    if (first < 1 || first > length || last < first || last < 1) return [];
    if (last - first + 1 > 1_000_000) throw new LuaError('string.byte result too large');
    const result: Value[] = [];
    for (let i = first; i <= last; i++) result.push(s.charCodeAt(i - 1));
    return result;
  }));
  stringLib.set('sub', fn('sub', (args) => {
    const s = String(args[0]);
    const length = s.length;
    const normalize = (index: number, isLast: boolean) =>
      index < 0 ? Math.max(length + index + 1, 1) : isLast ? Math.min(index, length) : index;
    const firstRaw = toNumber(args[1], at);
    const lastRaw = args[2] === undefined ? -1 : toNumber(args[2], at);
    if (!Number.isInteger(firstRaw) || !Number.isInteger(lastRaw)) throw new LuaError('bad argument to string.sub (integer index expected)');
    const first = normalize(firstRaw, false);
    const last = normalize(lastRaw, true);
    if (first < 1 || first > length || last < first) return [''];
    return [s.slice(first - 1, last)];
  }));
  stringLib.set('rep', fn('rep', (args) => {
    const s = String(args[0]);
    const count = toNumber(args[1], at);
    const sep = args[2] === undefined ? '' : String(args[2]);
    if (!Number.isInteger(count) || count < 0) throw new LuaError('bad argument to string.rep (invalid count)');
    if (count === 0) return [''];
    const resultLength = s.length * count + sep.length * (count - 1);
    if (!Number.isSafeInteger(resultLength) || resultLength > 10_000_000) throw new LuaError('string.rep result too large');
    return [Array(count).fill(s).join(sep)];
  }));
  g.set('string', stringLib);

  const mathLib = new LuaTable();
  let randomState = 0x6d2b79f5;
  const randomUnit = () => {
    // xorshift32: reproducible PRNG for Lua math.random, not cryptography.
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  };
  const mathUnary: Record<string, (n: number) => number> = {
    abs: Math.abs, acos: Math.acos, asin: Math.asin, atan: Math.atan,
    ceil: Math.ceil, cos: Math.cos, cosh: Math.cosh, deg: (n) => n * 180 / Math.PI,
    exp: Math.exp, floor: Math.floor, log: Math.log, log10: Math.log10,
    rad: (n) => n * Math.PI / 180, sin: Math.sin, sinh: Math.sinh,
    sqrt: Math.sqrt, tan: Math.tan, tanh: Math.tanh,
  };
  for (const [name, operation] of Object.entries(mathUnary)) {
    mathLib.set(name, fn(name, (args) => [operation(toNumber(args[0], at))]));
  }
  mathLib.set('atan2', fn('atan2', (args) => [Math.atan2(toNumber(args[0], at), toNumber(args[1], at))]));
  mathLib.set('atan', fn('atan', (args) => [
    args[1] === undefined
      ? Math.atan(toNumber(args[0], at))
      : Math.atan2(toNumber(args[0], at), toNumber(args[1], at)),
  ]));
  mathLib.set('log', fn('log', (args) => {
    const value = Math.log(toNumber(args[0], at));
    return [args[1] === undefined ? value : value / Math.log(toNumber(args[1], at))];
  }));

  mathLib.set('fmod', fn('fmod', (args) => [toNumber(args[0], at) % toNumber(args[1], at)]));
  mathLib.set('max', fn('max', (args) => {
    if (args.length === 0) throw new LuaError('bad argument to math.max (value expected)');
    return [Math.max(...args.map((value) => toNumber(value, at)))];
  }));
  mathLib.set('min', fn('min', (args) => {
    if (args.length === 0) throw new LuaError('bad argument to math.min (value expected)');
    return [Math.min(...args.map((value) => toNumber(value, at)))];
  }));
  mathLib.set('clamp', fn('clamp', (args) => {
    const value = toNumber(args[0], at);
    const minimum = toNumber(args[1], at);
    const maximum = toNumber(args[2], at);
    if (minimum > maximum) throw new LuaError('bad argument to math.clamp (min must be <= max)');
    return [Math.min(Math.max(value, minimum), maximum)];
  }));
  mathLib.set('sign', fn('sign', (args) => [Math.sign(toNumber(args[0], at))]));
  mathLib.set('round', fn('round', (args) => {
    const value = toNumber(args[0], at);
    return [value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)];
  }));
  mathLib.set('modf', fn('modf', (args) => {
    const value = toNumber(args[0], at);
    const integer = value < 0 ? Math.ceil(value) : Math.floor(value);
    return [integer, value - integer];
  }));
  mathLib.set('tointeger', fn('tointeger', (args) => {
    const value = args[0];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return [undefined];
    return [value];
  }));
  mathLib.set('type', fn('type', (args) => {
    const value = args[0];
    return [typeof value !== 'number' ? undefined : Number.isSafeInteger(value) ? 'integer' : 'float'];
  }));
  mathLib.set('randomseed', fn('randomseed', (args) => {
    const seed = toNumber(args[0], at);
    if (!Number.isSafeInteger(seed)) throw new LuaError('bad argument to math.randomseed (integer expected)');
    randomState = seed >>> 0;
    if (randomState === 0) randomState = 0x6d2b79f5;
    return [];
  }));
  mathLib.set('random', fn('random', (args) => {
    if (args.length === 0) return [randomUnit()];
    const minimum = args.length > 1 ? toNumber(args[0], at) : 1;
    const maximum = args.length > 1 ? toNumber(args[1], at) : toNumber(args[0], at);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) {
      throw new LuaError('bad argument to math.random (interval is empty)');
    }
    const range = maximum - minimum + 1;
    if (!Number.isSafeInteger(range) || range > 0x1_0000_0000) {
      throw new LuaError('bad argument to math.random (interval is too large)');
    }
    return [minimum + Math.floor(randomUnit() * range)];
  }));
  mathLib.set('pi', Math.PI);
  mathLib.set('huge', Infinity);
  g.set('math', mathLib);

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
