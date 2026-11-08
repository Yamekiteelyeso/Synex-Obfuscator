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


function luaPatternToRegExp(pattern: string): RegExp {
  if (pattern.length > 4096) throw new LuaError('Lua pattern too large');
  if (pattern.endsWith('%')) throw new LuaError("malformed Lua pattern (ends with '%')");
  const classFor = (code: string): string | undefined => {
    const lower: Record<string, string> = {
      a: 'A-Za-z', c: '\\x00-\\x1F\\x7F', d: '0-9', g: '!-~',
      l: 'a-z', p: '\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E', s: '\\x09-\\x0D\\x20', u: 'A-Z',
      w: 'A-Za-z0-9', x: 'A-Fa-f0-9', z: '\\x00',
    };
    const key = code.toLowerCase();
    const value = lower[key];
    if (!value) return undefined;
    return code === key ? value : '^' + value;
  };
  const escape = (ch: string) => /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch;
  const escapeLuaLiteral = (ch: string) => ['\\', ']', '{', '}', '|'].includes(ch) ? '\\' + ch : ch;
  let output = '';
  let inClass = false;
  let previousWasQuantifier = false;
  let lastAtomIsWildcard = false;
  let wildcardRepeats = 0;
  let quantifierCount = 0;
  let captureCount = 0;
  const groupHasQuantifier: boolean[] = [];
  let lastClosedGroupHasQuantifier = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '%' ) {
      const next = pattern[++i];
      if (next === 'b' || next === 'f') throw new LuaError('Lua pattern %' + next + ' is not supported yet');
      const cls = classFor(next);
      if (cls !== undefined) {
        if (inClass && cls.startsWith('^')) throw new LuaError('negated Lua character class inside [] is unsupported');
        output += inClass ? cls : '[' + cls + ']';
      } else if (next >= '1' && next <= '9') {
        if (inClass) throw new LuaError('Lua capture references inside character classes are unsupported');
        if (Number(next) > captureCount) throw new LuaError('invalid Lua pattern backreference');
        output += '\\' + next;
      } else output += escape(next);
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (ch === '[') {
      if (inClass) throw new LuaError('malformed Lua pattern (nested character class)');
      inClass = true;
      output += '[';
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      output += ']';
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (inClass) {
      output += ch;
      continue;
    }
    if (ch === '(') {
      if (pattern[i + 1] === ')') throw new LuaError('Lua position captures () are not supported yet');
      if (++captureCount > 32) throw new LuaError('Lua pattern has too many captures');
      groupHasQuantifier.push(false);
      output += '(';
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (ch === ')') {
      const hasQuantifier = groupHasQuantifier.pop();
      if (hasQuantifier === undefined) throw new LuaError('malformed Lua pattern (unexpected ))');
      if (groupHasQuantifier.length && hasQuantifier) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      output += ')';
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = hasQuantifier;
      continue;
    }
    if ('*+?-'.includes(ch)) {
      if (previousWasQuantifier || lastClosedGroupHasQuantifier || output.length === 0) {
        throw new LuaError('malformed or unsafe Lua pattern repetition');
      }
      if (lastAtomIsWildcard && ++wildcardRepeats > 1) {
        throw new LuaError('Lua pattern contains too many repeated wildcards');
      }
      if (++quantifierCount > 32) throw new LuaError('Lua pattern contains too many repetitions');
      if (groupHasQuantifier.length) groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      output += ch === '-' ? '*?' : ch;
      previousWasQuantifier = true;
      lastAtomIsWildcard = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (ch === '.') {
      output += '[\\s\\S]';
      lastAtomIsWildcard = true;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    if (ch === '^' || ch === '$') {
      if (ch === '^' && i === 0) output += '^';
      else if (ch === '$' && i === pattern.length - 1) output += '$(?![\\s\\S])';
      else output += '\\' + ch;
      lastAtomIsWildcard = false;
      previousWasQuantifier = false;
      lastClosedGroupHasQuantifier = false;
      continue;
    }
    output += escapeLuaLiteral(ch);
    lastAtomIsWildcard = false;
    previousWasQuantifier = false;
    lastClosedGroupHasQuantifier = false;
  }
  if (inClass) throw new LuaError('malformed Lua pattern (missing ])');
  if (groupHasQuantifier.length) throw new LuaError('malformed Lua pattern (unfinished capture)');
  try { return new RegExp(output, 'g'); }
  catch { throw new LuaError('malformed Lua pattern'); }
}


// Hash/gradient constants and interpolation are adapted from Luau VM/src/lmathlib.cpp (MIT); see packages/runtime/third_party/LUAU-NOISE-NOTICE.md.
const PERLIN_HASH = [
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,
  190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,
  125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,
  41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,
  116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,
  206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,
  12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,
  127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,151,
] as const;

const PERLIN_GRADIENTS = [
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1],
  [1,1,0],[0,-1,1],[-1,1,0],[0,-1,-1],
] as const;

/** Luau-compatible 3D Perlin noise with float32 intermediates and 256-unit period. */
function luauPerlinNoise(x: number, y: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return Number.NaN;
  const f = Math.fround;
  // Luau's current implementation wraps coordinates before converting to float,
  // avoiding precision loss for large inputs while preserving its 256-unit period.
  const px = f(x % 256);
  const py = f(y % 256);
  const pz = f(z % 256);
  const xFloor = Math.floor(px);
  const yFloor = Math.floor(py);
  const zFloor = Math.floor(pz);
  const xi = xFloor & 255;
  const yi = yFloor & 255;
  const zi = zFloor & 255;
  const xf = f(px - xFloor);
  const yf = f(py - yFloor);
  const zf = f(pz - zFloor);
  const fade = (t: number): number => {
    const cubic = f(f(t * t) * t);
    const inner = f(f(f(t * 6) - 15) * t + 10);
    return f(cubic * inner);
  };
  const lerp = (t: number, a: number, b: number): number => f(a + f(t * f(b - a)));
  const grad = (hash: number, dx: number, dy: number, dz: number): number => {
    const g = PERLIN_GRADIENTS[hash & 15];
    return f(f(f(g[0] * dx) + f(g[1] * dy)) + f(g[2] * dz));
  };
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  const p = PERLIN_HASH;
  const a = (p[xi] + yi) & 255;
  const aa = (p[a] + zi) & 255;
  const ab = (p[a + 1] + zi) & 255;
  const b = (p[xi + 1] + yi) & 255;
  const ba = (p[b] + zi) & 255;
  const bb = (p[b + 1] + zi) & 255;
  const la = lerp(u, grad(p[aa], xf, yf, zf), grad(p[ba], f(xf - 1), yf, zf));
  const lb = lerp(u, grad(p[ab], xf, f(yf - 1), zf), grad(p[bb], f(xf - 1), f(yf - 1), zf));
  const la1 = lerp(u, grad(p[aa + 1], xf, yf, f(zf - 1)), grad(p[ba + 1], f(xf - 1), yf, f(zf - 1)));
  const lb1 = lerp(u, grad(p[ab + 1], xf, f(yf - 1), f(zf - 1)), grad(p[bb + 1], f(xf - 1), f(yf - 1), f(zf - 1)));
  return lerp(w, lerp(v, la, lb), lerp(v, la1, lb1));
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
    let result = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      result += String.fromCharCode(...bytes.slice(offset, offset + 8192));
    }
    return [result];
  }));
  stringLib.set('gmatch', fn('gmatch', (args) => {
    const source = String(args[0]);
    const regex = luaPatternToRegExp(String(args[1]));
    let position = 0;
    let finished = false;
    const iterator = new NativeFunction(() => {
      if (finished) return [undefined];
      regex.lastIndex = position;
      const match = regex.exec(source);
      if (!match) { finished = true; return [undefined]; }
      const next = match.index + match[0].length;
      position = next > match.index ? next : match.index + 1;
      if (position > source.length) finished = true;
      return match.length > 1 ? match.slice(1) : [match[0]];
    });
    return [iterator];
  }));
  stringLib.set('match', fn('match', (args) => {
    const source = String(args[0]);
    const pattern = String(args[1]);
    const init = args[2] === undefined ? 1 : toNumber(args[2], at);
    if (!Number.isSafeInteger(init)) throw new LuaError('bad argument to string.match (integer index expected)');
    const start = init < 0 ? source.length + init + 1 : init;
    if (start < 1 || start > source.length + 1) return [undefined];
    const regex = luaPatternToRegExp(pattern);
    regex.lastIndex = start - 1;
    const match = regex.exec(source);
    if (!match) return [undefined];
    return match.length > 1 ? match.slice(1) : [match[0]];
  }));
  stringLib.set('gsub', fn('gsub', (args) => {
    const source = String(args[0]);
    const pattern = String(args[1]);
    const replacement = args[2];
    const limit = args[3] === undefined ? Number.MAX_SAFE_INTEGER : toNumber(args[3], at);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new LuaError('bad argument to string.gsub (invalid count)');
    if (limit === 0) return [source, 0];
    if (typeof replacement !== 'string' && !(replacement instanceof LuaFunction) && !(replacement instanceof LuaTable)) {
      throw new LuaError('bad argument to string.gsub (string, table, or function expected)');
    }
    const regex = luaPatternToRegExp(pattern);
    let count = 0;
    let output = '';
    let outputCursor = 0;
    let searchCursor = 0;
    while (count < limit) {
      regex.lastIndex = searchCursor;
      const found = regex.exec(source);
      if (!found) break;
      const match = found[0];
      const captures = found.slice(1);
      output += source.slice(outputCursor, found.index);
      let rendered: string;
      if (typeof replacement === 'string') {
        rendered = '';
        for (let index = 0; index < replacement.length; index++) {
          if (replacement[index] !== '%') { rendered += replacement[index]; continue; }
          const token = replacement[++index];
          if (token === '%') rendered += '%';
          else if (token >= '0' && token <= '9') {
            const captureIndex = Number(token);
            if (captureIndex === 0) rendered += match;
            else if (captureIndex > captures.length) throw new LuaError('invalid capture index in string.gsub replacement');
            else rendered += captures[captureIndex - 1] ?? '';
          } else throw new LuaError("invalid use of '%' in string.gsub replacement");
        }
      } else if (replacement instanceof LuaTable) {
        const key = captures.length ? captures[0] : match;
        const value = replacement.get(key);
        if (value === undefined || value === false) rendered = match;
        else if (typeof value === 'string') rendered = value;
        else if (typeof value === 'number') rendered = numberToString(value);
        else throw new LuaError('invalid string.gsub replacement value (string or number expected)');
      } else {
        const callArgs: Value[] = captures.length ? captures : [match];
        const result = call(replacement, callArgs)[0];
        if (result === undefined || result === false) rendered = match;
        else if (typeof result === 'string') rendered = result;
        else if (typeof result === 'number') rendered = numberToString(result);
        else throw new LuaError('invalid string.gsub replacement value (string or number expected)');
      }
      output += rendered;
      count++;
      outputCursor = found.index + match.length;
      searchCursor = outputCursor > found.index ? outputCursor : found.index + 1;
      if (searchCursor > source.length) break;
    }
    output += source.slice(outputCursor);
    return [output, count];
  }));
  stringLib.set('find', fn('find', (args) => {
    const source = String(args[0]);
    const pattern = String(args[1]);
    const init = args[2] === undefined ? 1 : toNumber(args[2], at);
    const plain = args[3] === true;
    if (!Number.isSafeInteger(init)) throw new LuaError('bad argument to string.find (integer index expected)');
    const start = init < 0 ? source.length + init + 1 : init;
    if (start < 1 || start > source.length + 1) return [undefined];
    if (plain) {
      const index = source.indexOf(pattern, start - 1);
      return index < 0 ? [undefined] : [index + 1, index + pattern.length];
    }
    const regex = luaPatternToRegExp(pattern);
    regex.lastIndex = start - 1;
    const match = regex.exec(source);
    return match ? [match.index + 1, match.index + match[0].length, ...match.slice(1)] : [undefined];
  }));
  stringLib.set('format', fn('format', (args) => {
    const template = String(args[0]);
    let argument = 1;
    let output = '';
    const quote = (value: string) => {
      const slash = String.fromCharCode(92);
      let escaped = '';
      for (let index = 0; index < value.length; index++) {
        const ch = value[index];
        const code = value.charCodeAt(index);
        if (code === 34) escaped += slash + '"';
        else if (code === 92) escaped += slash + slash;
        else if (code === 10) escaped += slash + 'n';
        else if (code === 13) escaped += slash + 'r';
        else if (code === 9) escaped += slash + 't';
        else if (code < 32 || code === 127) escaped += slash + String(code).padStart(3, '0');
        else escaped += ch;
      }
      return '"' + escaped + '"';
    };
    for (let index = 0; index < template.length; index++) {
      if (template[index] !== '%') { output += template[index]; continue; }
      if (template[index + 1] === '%') { output += '%'; index++; continue; }
      const match = /^%([-+ #0]*)(\d*)(?:\.(\d+))?([cdiuoxXfFeEgGqs])/.exec(template.slice(index));
      if (!match) throw new LuaError('invalid format specifier near ' + template.slice(index, index + 8));
      const [, flags, widthText, precisionText, spec] = match;
      const width = widthText ? Number(widthText) : 0;
      const precision = precisionText === undefined ? undefined : Number(precisionText);
      if (width > 100_000 || (precision ?? 0) > 1000) throw new LuaError('string.format field width or precision too large');
      const value = args[argument++];
      if (value === undefined) throw new LuaError('bad argument to string.format (no value)');
      let rendered: string;
      if (spec === 's') {
        if (typeof value !== 'string') throw new LuaError('bad argument to string.format (string expected for %s)');
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
    if (count === 0 || (s === '' && sep === '')) return [''];
    const resultLength = s.length * count + sep.length * (count - 1);
    if (!Number.isSafeInteger(resultLength) || resultLength > 10_000_000) throw new LuaError('string.rep result too large');
    return [(s + sep).repeat(count - 1) + s];
  }));
  g.set('string', stringLib);

  const mathLib = new LuaTable();
  let randomState = 0n;
  // PCG32 transition and seed procedure follow Luau VM/src/lmathlib.cpp (MIT).
  const pcg32Random = (): number => {
    const oldState = randomState;
    randomState = BigInt.asUintN(64, oldState * 6364136223846793005n + 105n);
    const shifted = Number((((oldState >> 18n) ^ oldState) >> 27n) & 0xffff_ffffn) >>> 0;
    const rotation = Number(oldState >> 59n);
    return ((shifted >>> rotation) | (shifted << ((-rotation) & 31))) >>> 0;
  };
  const seedRandom = (seed: number): void => {
    randomState = 0n;
    pcg32Random();
    randomState = BigInt.asUintN(64, randomState + BigInt(seed));
    pcg32Random();
  };
  // Stable default seed for repeatable tests; callers can reset the stream with math.randomseed.
  seedRandom(0x6d2b79f5);
  const randomUnit = (): number => {
    const low = BigInt(pcg32Random());
    const high = BigInt(pcg32Random());
    return Number(low | (high << 32n)) / 0x1_0000_0000_0000_0000;
  };
  const randomInteger32 = (value: Value, functionName: string): number => {
    const raw = toNumber(value, at);
    const integer = Math.trunc(raw);
    if (!Number.isFinite(raw) || !Number.isSafeInteger(integer)
      || integer < -0x8000_0000 || integer > 0x7fff_ffff) {
      throw new LuaError('bad argument to ' + functionName + ' (integer expected)');
    }
    return integer;
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
    let result = toNumber(args[0], at);
    for (let index = 1; index < args.length; index++) {
      const value = toNumber(args[index], at);
      if (value > result) result = value;
    }
    return [result];
  }));
  mathLib.set('min', fn('min', (args) => {
    if (args.length === 0) throw new LuaError('bad argument to math.min (value expected)');
    let result = toNumber(args[0], at);
    for (let index = 1; index < args.length; index++) {
      const value = toNumber(args[index], at);
      if (value < result) result = value;
    }
    return [result];
  }));
  mathLib.set('clamp', fn('clamp', (args) => {
    const value = toNumber(args[0], at);
    const minimum = toNumber(args[1], at);
    const maximum = toNumber(args[2], at);
    if (minimum > maximum) throw new LuaError('bad argument to math.clamp (min must be <= max)');
    return [Math.min(Math.max(value, minimum), maximum)];
  }));
  mathLib.set('sign', fn('sign', (args) => {
    const value = toNumber(args[0], at);
    return [Number.isNaN(value) || value === 0 ? 0 : value > 0 ? 1 : -1];
  }));
  mathLib.set('pow', fn('pow', (args) => [Math.pow(toNumber(args[0], at), toNumber(args[1], at))]));
  mathLib.set('isnan', fn('isnan', (args) => [Number.isNaN(toNumber(args[0], at))]));
  mathLib.set('isinf', fn('isinf', (args) => [!Number.isNaN(toNumber(args[0], at)) && !Number.isFinite(toNumber(args[0], at))]));
  mathLib.set('isfinite', fn('isfinite', (args) => [Number.isFinite(toNumber(args[0], at))]));
  mathLib.set('noise', fn('noise', (args) => {
    if (args.length < 1 || args.length > 3) throw new LuaError('bad argument to math.noise (expected one to three coordinates)');
    const x = toNumber(args[0], at);
    const y = args[1] === undefined ? 0 : toNumber(args[1], at);
    const z = args[2] === undefined ? 0 : toNumber(args[2], at);
    return [luauPerlinNoise(x, y, z)];
  }));
  mathLib.set('lerp', fn('lerp', (args) => {
    const start = toNumber(args[0], at);
    const finish = toNumber(args[1], at);
    const alpha = toNumber(args[2], at);
    return [alpha === 1 ? finish : start + (finish - start) * alpha];
  }));
  mathLib.set('map', fn('map', (args) => {
    const value = toNumber(args[0], at);
    const inputMin = toNumber(args[1], at);
    const inputMax = toNumber(args[2], at);
    const outputMin = toNumber(args[3], at);
    const outputMax = toNumber(args[4], at);
    return [outputMin + (value - inputMin) * (outputMax - outputMin) / (inputMax - inputMin)];
  }));
  mathLib.set('round', fn('round', (args) => {
    const value = toNumber(args[0], at);
    return [value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)];
  }));
  mathLib.set('modf', fn('modf', (args) => {
    const value = toNumber(args[0], at);
    const integer = value < 0 ? Math.ceil(value) : Math.floor(value);
    return [integer, value - integer];
  }));
  const frexp = (value: number): [number, number] => {
    if (value === 0 || !Number.isFinite(value)) return [value, 0];
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    const high = view.getUint32(0, false);
    const exponentBits = (high >>> 20) & 0x7ff;
    if (exponentBits === 0) {
      const [fraction, exponent] = frexp(value * (2 ** 54));
      return [fraction, exponent - 54];
    }
    view.setUint32(0, (high & 0x800fffff) | (1022 << 20), false);
    return [view.getFloat64(0, false), exponentBits - 1022];
  };
  mathLib.set('frexp', fn('frexp', (args) => frexp(toNumber(args[0], at))));
  mathLib.set('ldexp', fn('ldexp', (args) => {
    let value = toNumber(args[0], at);
    let exponent = toNumber(args[1], at);
    if (!Number.isSafeInteger(exponent)) throw new LuaError('bad argument to math.ldexp (integer exponent expected)');
    if (value === 0 || !Number.isFinite(value) || exponent === 0) return [value];
    if (exponent > 2200) return [value > 0 ? Infinity : -Infinity];
    if (exponent < -2200) return [value > 0 ? 0 : -0];
    while (exponent > 1023) {
      value *= 2 ** 1023;
      exponent -= 1023;
      if (!Number.isFinite(value)) return [value];
    }
    while (exponent < -1022) {
      value *= 2 ** -1022;
      exponent += 1022;
      if (value === 0) return [value];
    }
    return [value * (2 ** exponent)];
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
    if (args.length !== 1) throw new LuaError('bad argument to math.randomseed (one seed expected)');
    const seed = toNumber(args[0], at);
    if (!Number.isSafeInteger(seed) || seed < -0x8000_0000 || seed > 0x7fff_ffff) {
      throw new LuaError('bad argument to math.randomseed (integer expected)');
    }
    seedRandom(seed);
    return [];
  }));
  mathLib.set('random', fn('random', (args) => {
    if (args.length === 0) return [randomUnit()];
    if (args.length === 1) {
      const upper = randomInteger32(args[0], 'math.random');
      if (upper < 1) throw new LuaError('bad argument to math.random (interval is empty)');
      const scaled = (BigInt(upper) * BigInt(pcg32Random())) >> 32n;
      return [1 + Number(scaled)];
    }
    if (args.length === 2) {
      const lower = randomInteger32(args[0], 'math.random');
      const upper = randomInteger32(args[1], 'math.random');
      if (lower > upper) throw new LuaError('bad argument to math.random (interval is empty)');
      const range = upper - lower + 1;
      if (range > 0xffff_ffff) throw new LuaError('bad argument to math.random (interval is too large)');
      const scaled = (BigInt(range) * BigInt(pcg32Random())) >> 32n;
      return [lower + Number(scaled)];
    }
    throw new LuaError('bad argument to math.random (wrong number of arguments)');
  }));
  mathLib.set('pi', Math.PI);
  mathLib.set('huge', Infinity);
  mathLib.set('nan', Number.NaN);
  mathLib.set('e', Math.E);
  mathLib.set('phi', 1.618033988749895);
  mathLib.set('sqrt2', Math.SQRT2);
  mathLib.set('tau', 2 * Math.PI);
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
