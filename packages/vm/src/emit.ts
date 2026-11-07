import { analyze } from '@synex/semantic';
import { parse } from '@synex/parser';
import { compile, type Instr, type Op, type Proto } from '@synex/ir';
import { SynexError } from '@synex/shared';
import { validateProto } from './validate.js';

/**
 * Transformación mediante VM. El programa se compila al IR de Synex y se
 * sustituye por un prototipo serializado más un intérprete de ese IR escrito
 * en Luau (con un subconjunto compatible con Lua 5.4). Cada build asigna
 * códigos de operación aleatorios, así que el bytecode de una salida no sirve
 * para otra.
 *
 * Limitaciones: sin límite de pasos en la VM generada, y los mensajes de error
 * en tiempo de ejecución no reproducen la posición de línea del original.
 */

/** Todas las operaciones del IR. El tipo obliga a listarlas todas. */
const ALL_OPS = [
  'CONST', 'NIL', 'TRUE', 'FALSE', 'POP',
  'GETL', 'SETL', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT',
  'GETUP', 'SETUP', 'GETG', 'SETG',
  'GETI', 'SETI', 'SELF',
  'ADD', 'SUB', 'MUL', 'DIV', 'IDIV', 'MOD', 'POW', 'CONCAT',
  'EQ', 'NE', 'LT', 'LE', 'GT', 'GE',
  'NEG', 'NOT', 'LEN',
  'JMP', 'JF', 'JFK', 'JTK',
  'FORTEST', 'FORSTEP', 'GENCALL',
  'CALL', 'RET', 'VARARG', 'ADJUST',
  'CLOSURE', 'NEWT', 'SETT', 'TAPPEND', 'TAPPENDM',
] as const satisfies readonly Op[];

type MissingOps = Exclude<Op, (typeof ALL_OPS)[number]>;
const allOpsComplete: [MissingOps] extends [never] ? true : false = true;
void allOpsComplete;

/** Generador determinista (mulberry32) para permutar códigos de operación. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Asigna a cada operación un código entero distinto y aleatorio (1..3N). */
export function opcodeTable(seed: number): Record<Op, number> {
  const rand = rng(seed);
  const pool = Array.from({ length: ALL_OPS.length * 3 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const table = {} as Record<Op, number>;
  ALL_OPS.forEach((op, i) => (table[op] = pool[i]));
  return table;
}

function luaString(s: string): string {
  const bytes = /^[\x00-\xff]*$/.test(s) ? Buffer.from(s, 'latin1') : Buffer.from(s, 'utf8');
  let out = '"';
  for (const b of bytes) {
    const plain = b >= 32 && b < 127 && b !== 34 && b !== 92;
    out += plain ? String.fromCharCode(b) : '\\' + String(b).padStart(3, '0');
  }
  return out + '"';
}

function luaNumber(n: number): string {
  if (Number.isNaN(n)) return '(0/0)';
  if (n === Infinity) return '(1/0)';
  if (n === -Infinity) return '(-1/0)';
  return String(n);
}

function luaConst(v: unknown): string {
  if (v === undefined || v === null) return 'nil';
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'number') return luaNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  throw new SynexError('constante no serializable en la VM', 1, 1, 'E_INTERNAL');
}

function serializeProto(p: Proto, ops: Record<Op, number>): string {
  // Instrucciones: {op, a, b, t, c}. Los saltos usan índices 1-based en la VM.
  const code = p.code.map((ins: Instr) =>
    `{${ops[ins.op]},${ins.a ?? 0},${ins.b ?? 0},${ins.t !== undefined ? ins.t + 1 : 0},${ins.c ? 1 : 0},${ins.line ?? 0}}`).join(',');
  const consts = p.consts.map(luaConst).join(',');
  const upvals = p.upvals.map((d) => `{${d.fromLocal ? 1 : 0},${d.index}}`).join(',');
  const children = p.protos.map((c) => serializeProto(c, ops)).join(',');
  return `{np=${p.nparams},va=${p.isVararg ? 'true' : 'false'},c={${code}},k={${consts}},q={${children}},u={${upvals}}}`;
}

/**
 * Plantilla del intérprete. Los identificadores OP_<NOMBRE> se sustituyen por
 * los códigos aleatorios de cada build. Sólo usa construcciones válidas en
 * Luau y en Lua 5.4 (sin goto, continue, operadores de bits ni "//").
 */
const TEMPLATE = String.raw`
local strlib, tbl, floor = string, table, math.floor
local typefn, select, setmt, getmt, errorfn = type, select, setmetatable, getmetatable, error
local STEP_LIMIT = __LIMIT__
local steps, curLine = 0, 0
local function fail(msg) errorfn("línea " .. curLine .. ": " .. msg, 0) end
local MULTI = {}
local function multi(n) return setmt({n = n}, MULTI) end
local function isMulti(v) return typefn(v) == "table" and getmt(v) == MULTI end
local function pack(...) return {n = select("#", ...), ...} end
local function index(o, k)
  local t = typefn(o)
  if t == "table" then return o[k] end
  if t == "string" then return strlib[k] end
  fail("attempt to index " .. t .. " value")
end
local run
local function callv(f, args)
  if typefn(f) ~= "function" then fail("attempt to call " .. typefn(f) .. " value") end
  return pack(f(tbl.unpack(args, 1, args.n)))
end
local function makeClosure(child, cells)
  return function(...)
    local res = run(child, cells, pack(...))
    return tbl.unpack(res, 1, res.n)
  end
end
run = function(P, U, args)
  local slots = {}
  local np = P.np
  for i = 1, np do slots[i] = args[i] end
  local va, nva = {}, 0
  if P.va then
    for i = np + 1, args.n do nva = nva + 1; va[nva] = args[i] end
  end
  local st, sp = {}, 0
  local code, pc = P.c, 1
  local function push(v) sp = sp + 1; st[sp] = v end
  local function pop()
    local v = st[sp]
    st[sp] = nil
    sp = sp - 1
    return v
  end
  local function popN(k)
    local out = {n = k}
    local base = sp - k
    for i = 1, k do out[i] = st[base + i]; st[base + i] = nil end
    sp = base
    return out
  end
  local function popMulti()
    local m = pop()
    if not isMulti(m) then fail("pila inconsistente") end
    return popN(m.n)
  end
  local function join(fixed, extra)
    local out = {n = fixed.n + extra.n}
    for i = 1, fixed.n do out[i] = fixed[i] end
    for i = 1, extra.n do out[fixed.n + i] = extra[i] end
    return out
  end
  while true do
    local ins = code[pc]
    pc = pc + 1
    local op, a, b, t, c = ins[1], ins[2], ins[3], ins[4], ins[5] == 1
    steps = steps + 1
    if steps > STEP_LIMIT then fail("límite de ejecución superado") end
    curLine = ins[6]
    if op == OP_CONST then push(P.k[a + 1])
    elseif op == OP_NIL then push(nil)
    elseif op == OP_TRUE then push(true)
    elseif op == OP_FALSE then push(false)
    elseif op == OP_POP then pop()
    elseif op == OP_GETL then push(slots[a + 1])
    elseif op == OP_SETL then slots[a + 1] = pop()
    elseif op == OP_NEWBOX then slots[a + 1] = {v = pop()}
    elseif op == OP_BOXSLOT then slots[a + 1] = {v = slots[a + 1]}
    elseif op == OP_GETBOX then push(slots[a + 1].v)
    elseif op == OP_SETBOX then slots[a + 1].v = pop()
    elseif op == OP_GETUP then push(U[a + 1].v)
    elseif op == OP_SETUP then U[a + 1].v = pop()
    elseif op == OP_GETG then push(_G[P.k[a + 1]])
    elseif op == OP_SETG then _G[P.k[a + 1]] = pop()
    elseif op == OP_GETI then
      local k = pop()
      local o = pop()
      push(index(o, k))
    elseif op == OP_SETI then
      local v = pop()
      local k = pop()
      local o = pop()
      if typefn(o) ~= "table" then fail("attempt to index " .. typefn(o) .. " value") end
      o[k] = v
    elseif op == OP_SELF then
      local o = pop()
      push(index(o, P.k[a + 1]))
      push(o)
    elseif op == OP_ADD then local y = pop(); local x = pop(); push(x + y)
    elseif op == OP_SUB then local y = pop(); local x = pop(); push(x - y)
    elseif op == OP_MUL then local y = pop(); local x = pop(); push(x * y)
    elseif op == OP_DIV then local y = pop(); local x = pop(); push(x / y)
    elseif op == OP_IDIV then local y = pop(); local x = pop(); push(floor(x / y))
    elseif op == OP_MOD then local y = pop(); local x = pop(); push(x - floor(x / y) * y)
    elseif op == OP_POW then local y = pop(); local x = pop(); push(x ^ y)
    elseif op == OP_CONCAT then local y = pop(); local x = pop(); push(x .. y)
    elseif op == OP_EQ then local y = pop(); local x = pop(); push(x == y)
    elseif op == OP_NE then local y = pop(); local x = pop(); push(x ~= y)
    elseif op == OP_LT then local y = pop(); local x = pop(); push(x < y)
    elseif op == OP_LE then local y = pop(); local x = pop(); push(x <= y)
    elseif op == OP_GT then local y = pop(); local x = pop(); push(y < x)
    elseif op == OP_GE then local y = pop(); local x = pop(); push(y <= x)
    elseif op == OP_NEG then push(-pop())
    elseif op == OP_NOT then push(not pop())
    elseif op == OP_LEN then push(#pop())
    elseif op == OP_JMP then pc = t
    elseif op == OP_JF then
      local v = pop()
      if not v then pc = t end
    elseif op == OP_JFK then
      if not st[sp] then pc = t else pop() end
    elseif op == OP_JTK then
      if st[sp] then pc = t else pop() end
    elseif op == OP_FORTEST then
      local base = a + 1
      local i, lim, step = slots[base], slots[base + 1], slots[base + 2]
      local go
      if step > 0 then go = i <= lim else go = i >= lim end
      if not go then pc = t end
    elseif op == OP_FORSTEP then
      local base = a + 1
      slots[base] = slots[base] + slots[base + 2]
    elseif op == OP_GENCALL then
      local base = a + 1
      local res = callv(slots[base], {slots[base + 1], slots[base + 2], n = 2})
      if res[1] == nil then
        pc = t
      else
        slots[base + 2] = res[1]
        for k = 1, b do push(res[k]) end
      end
    elseif op == OP_CALL then
      local args
      if c then
        local extra = popMulti()
        args = join(popN(a), extra)
      else
        args = popN(a)
      end
      local f = pop()
      local res = callv(f, args)
      if b < 0 then
        for k = 1, res.n do push(res[k]) end
        push(multi(res.n))
      else
        for k = 1, b do push(res[k]) end
      end
    elseif op == OP_RET then
      local out
      if c then
        local extra = popMulti()
        out = join(popN(a), extra)
      else
        out = popN(a)
      end
      do return out end
    elseif op == OP_VARARG then
      if c then
        for k = 1, nva do push(va[k]) end
        push(multi(nva))
      else
        push(va[1])
      end
    elseif op == OP_ADJUST then
      local extra = popMulti()
      for k = 1, a do push(extra[k]) end
    elseif op == OP_CLOSURE then
      local child = P.q[a + 1]
      local cells = {}
      for i, d in ipairs(child.u) do
        if d[1] == 1 then cells[i] = slots[d[2] + 1] else cells[i] = U[d[2] + 1] end
      end
      push(makeClosure(child, cells))
    elseif op == OP_NEWT then push({})
    elseif op == OP_SETT then
      local v = pop()
      local k = pop()
      st[sp][k] = v
    elseif op == OP_TAPPEND then
      local v = pop()
      st[sp][a] = v
    elseif op == OP_TAPPENDM then
      local extra = popMulti()
      local tb = st[sp]
      for k = 1, extra.n do tb[a + k - 1] = extra[k] end
    else
      fail("operación desconocida " .. tostring(op))
    end
  end
end
local MAIN = __MAIN__
local function main(...)
  local res = run(MAIN, {}, pack(...))
  return tbl.unpack(res, 1, res.n)
end
return main(...)
`;

/** Emite el script Luau que ejecuta el prototipo principal dentro de la VM. */
export interface EmitOptions {
  /** Instrucciones máximas antes de abortar la ejecución. */
  stepLimit?: number;
}

export function emitLuauVm(main: Proto, seed = 1, options: EmitOptions = {}): string {
  validateProto(main);
  const limit = options.stepLimit ?? 5_000_000;
  if (!Number.isInteger(limit) || limit <= 0) throw new SynexError('límite de pasos inválido', 1, 1, 'E_OPTIONS');
  const ops = opcodeTable(seed);
  let body = TEMPLATE.replace(/\bOP_([A-Z]+)\b/g, (_m, name: string) => {
    const code = ops[name as Op];
    if (code === undefined) throw new Error(`operación sin código: ${name}`);
    return String(code);
  });
  body = body.replace('__LIMIT__', String(limit));
  body = body.replace('__MAIN__', serializeProto(main, ops));
  return body.trimStart();
}

/** Compila un script Luau al IR y lo emite como programa de VM. */
export function compileToLuauVm(source: string, seed = 1, options: EmitOptions = {}): string {
  const chunk = parse(source);
  const analysis = analyze(chunk);
  const [first] = analysis.diagnostics;
  if (first) throw new SynexError(first.message, first.line, first.column, first.code);
  return emitLuauVm(compile(chunk, analysis), seed, options);
}
