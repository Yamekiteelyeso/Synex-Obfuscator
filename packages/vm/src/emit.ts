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
 * La VM usa un límite global de instrucciones y resuelve los globals desde el
 * entorno de ejecución Luau (getfenv), además de permitir indexar userdata/Instances.
 */

/** Todas las operaciones del IR. El tipo obliga a listarlas todas. */
const ALL_OPS = [
  'CONST', 'NIL', 'TRUE', 'FALSE', 'POP',
  'GETL', 'SETL', 'MOVE', 'NEWBOX', 'GETBOX', 'SETBOX', 'BOXSLOT',
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

type ProtoKeys = { np: string; ns: string; va: string; code: string; constants: string; children: string; upvalues: string; salt: string; seal: string; blockmap: string; blocks: string };

/** Los nombres de los campos del prototipo también cambian por semilla. */
function protoKeys(seed: number): ProtoKeys {
  const rand = rng(seed ^ 0x51ed270b);
  const used = new Set<string>();
  const next = (): string => {
    let name = '';
    do { name = '_' + Math.floor(rand() * 0xffffff).toString(36); } while (used.has(name));
    used.add(name);
    return name;
  };
  return { np: next(), ns: next(), va: next(), code: next(), constants: next(), children: next(), upvalues: next(), salt: next(), seal: next(), blockmap: next(), blocks: next() };
}

function luaNumber(n: number): string {
  if (Number.isNaN(n)) return '(0/0)';
  if (n === Infinity) return '(1/0)';
  if (n === -Infinity) return '(-1/0)';
  return String(n);
}

function luaConst(v: unknown, seed: number, stringIndex: { value: number }): string {
  if (v === undefined || v === null) return 'nil';
  if (typeof v === 'string') {
    // Cifrado polimórfico del pool de constantes: cada literal usa una clave
    // distinta derivada de la semilla del build y se reconstruye en runtime.
    const bytes = Buffer.from(v, 'utf8');
    const index = ++stringIndex.value;
    const key = ((seed >>> 0) + index * 73) % 251 + 1;
    let state = key;
    const encoded = Array.from(bytes, (b, i) => {
      state = (state * 73 + 41) % 256;
      return (b + state + (i + 1) * 17) % 256;
    }).join(',');
    return `function() return unstr({${encoded}},${key}) end`;
  }
  if (typeof v === 'number') {
    // IEEE-754 little-endian: el literal numérico no se emite directamente.
    const raw = Buffer.alloc(8);
    raw.writeDoubleLE(v, 0);
    const index = ++stringIndex.value;
    const key = ((seed >>> 0) + index * 97) % 251 + 1;
    let state = key;
    const encoded = Array.from(raw, (byte, i) => {
      state = (state * 73 + 41) % 256;
      return (byte + state + (i + 1) * 29) % 256;
    }).join(',');
    return `function() return unnum({${encoded}},${key}) end`;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  throw new SynexError('constante no serializable en la VM', 1, 1, 'E_INTERNAL');
}

const OPERAND_MODULUS = 2147483647;

/** Enmascara cada campo con una clave derivada de semilla, prototipo, instrucción y posición. */
function encodeOperand(value: number, pc: number, field: number, seed: number, protoSalt: number): number {
  const normalized = ((value % OPERAND_MODULUS) + OPERAND_MODULUS) % OPERAND_MODULUS;
  const mask = ((seed >>> 0) + pc * 131 + field * 977 + protoSalt * 4099 + (pc * field * protoSalt * 17) % OPERAND_MODULUS) % OPERAND_MODULUS;
  return (normalized + mask) % OPERAND_MODULUS;
}

function protoSeal(
  code: number[][], seed: number, salt: number, nparams: number, nslots: number, isVararg: boolean,
  blockMap: number[], blockDescriptors: number[][], constantCount: number, childCount: number, upvalues: number[][],
): [number, number] {
  const normalizedSeed = (seed >>> 0) % OPERAND_MODULUS;
  let hashA = (normalizedSeed + salt * 97 + nparams * 17 + nslots * 31 + (isVararg ? 1 : 0)) % OPERAND_MODULUS;
  let hashB = (normalizedSeed * 65599 + salt * 131 + nparams * 257 + nslots * 911 + (isVararg ? 17 : 0)) % OPERAND_MODULUS;
  const mix = (value: number) => {
    hashA = (hashA * 33 + value) % OPERAND_MODULUS;
    hashB = (hashB * 65599 + value * 17 + (hashA % 65521)) % OPERAND_MODULUS;
  };
  // Dos acumuladores con recorridos dependientes detectan más alteraciones
  // accidentales que un checksum lineal simple; no son una firma criptográfica.
  for (const instruction of code) for (const value of instruction) mix(value);
  for (const block of blockMap) mix(block);
  for (const descriptor of blockDescriptors) for (const value of descriptor) mix(value);
  mix(constantCount); mix(childCount); mix(upvalues.length);
  for (const upvalue of upvalues) for (const value of upvalue) mix(value);
  return [hashA, hashB];
}

/** Codifica el número de línea con una transformación afín propia del prototipo. */
function encodeLineNumber(line: number, seed: number, salt: number): number {
  const normalizedSeed = (seed >>> 0) % OPERAND_MODULUS;
  const multiplier = 17 + ((normalizedSeed + salt * 131) % 31);
  const offset = (normalizedSeed + salt * 65537) % 1000003;
  return line * multiplier + offset;
}

/**
 * Fuse GETL + SETL en MOVE cuando el segundo registro no es destino de salto.
 * Se remapean todos los destinos originales antes de barajar el layout físico.
 * Sólo afecta a slots locales normales: los capturados usan GETBOX/SETBOX.
 */
function fuseSuperinstructions(code: Instr[]): Instr[] {
  const jumpTargets = new Set(code.flatMap((ins) => ins.t === undefined ? [] : [ins.t]));
  const fused: Instr[] = [];
  const oldToNew = new Array<number>(code.length);
  for (let i = 0; i < code.length;) {
    const current = code[i];
    const next = code[i + 1];
    oldToNew[i] = fused.length;
    if (current.op === 'GETL' && next?.op === 'SETL' && !jumpTargets.has(i + 1)) {
      oldToNew[i + 1] = fused.length;
      fused.push({ op: 'MOVE', a: current.a, b: next.a, line: current.line });
      i += 2;
    } else {
      fused.push({ ...current });
      i += 1;
    }
  }
  for (const ins of fused) {
    if (ins.t !== undefined) ins.t = oldToNew[ins.t];
  }
  return fused;
}

function serializeProto(p: Proto, ops: Record<Op, number>, keys: ProtoKeys, seed: number, stringIndex: { value: number }, protoCounter: { value: number }): string {
  // Cada prototipo recibe una sal propia; las máscaras no se repiten entre funciones hermanas.
  const protoSalt = ++protoCounter.value;
  const virtualCode = fuseSuperinstructions(p.code);
  // Randomize physical instruction storage independently for each prototype.
  const order = Array.from({ length: virtualCode.length }, (_, i) => i + 1);
  const shuffle = rng((seed ^ Math.imul(protoSalt, 0x45d9f3b)) >>> 0);
  // La primera instrucción lógica conserva el slot de entrada de la VM.
  for (let i = order.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(shuffle() * i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const physicalOf: number[] = [];
  order.forEach((originalPc, physicalIndex) => { physicalOf[originalPc] = physicalIndex + 1; });
  const encodedCode = order.map((originalPc, physicalIndex) => {
    const ins = virtualCode[originalPc - 1];
    const pc = physicalIndex + 1;
    const logicalTarget = ins.t !== undefined ? ins.t + 1 : 0;
    const target = logicalTarget ? physicalOf[logicalTarget] : 0;
    const nextLogical = originalPc < virtualCode.length ? originalPc + 1 : 0;
    const next = nextLogical ? physicalOf[nextLogical] : 0;
    const hiddenLine = encodeLineNumber(ins.line ?? 0, seed, protoSalt);
    const fields = [ops[ins.op], ins.a ?? 0, ins.b ?? 0, target, ins.c ? 1 : 0, hiddenLine, next];
    const encoded = fields.map((value, i) => encodeOperand(value, pc, i + 1, seed, protoSalt));
    const normalizedSeed = (seed >>> 0) % OPERAND_MODULUS;
    let checkA = (normalizedSeed + protoSalt * 97 + pc * 31) % OPERAND_MODULUS;
    let checkB = (normalizedSeed * 65599 + protoSalt * 131 + pc * 257) % OPERAND_MODULUS;
    for (const value of encoded) {
      checkA = (checkA * 33 + value) % OPERAND_MODULUS;
      checkB = (checkB * 65599 + value * 17 + (checkA % 65521)) % OPERAND_MODULUS;
    }
    // Dos sellos por instrucción permiten comprobar cada despacho, no sólo al entrar al bloque.
    return [...encoded, checkA, checkB];
  });
  // Bloques básicos: entrada, destinos de salto y sucesores de bifurcaciones.
  const leaders = new Set<number>([0]);
  virtualCode.forEach((ins, index) => {
    if (ins.t !== undefined) leaders.add(ins.t);
    if (['JMP', 'JF', 'JFK', 'JTK', 'FORTEST', 'GENCALL', 'RET'].includes(ins.op) && index + 1 < virtualCode.length) leaders.add(index + 1);
  });
  const sortedLeaders = [...leaders].sort((a, b) => a - b);
  const logicalBlock = new Array<number>(virtualCode.length);
  sortedLeaders.forEach((start, blockIndex) => {
    const end = sortedLeaders[blockIndex + 1] ?? virtualCode.length;
    for (let i = start; i < end; i++) logicalBlock[i] = blockIndex + 1;
  });
  const blockMembers = new Map<number, number[]>();
  order.forEach((originalPc, physicalIndex) => {
    const id = logicalBlock[originalPc - 1];
    const members = blockMembers.get(id) ?? [];
    members.push(physicalIndex + 1);
    blockMembers.set(id, members);
  });
  const blockMap = order.map((originalPc) => logicalBlock[originalPc - 1]);
  const blockDescriptorValues = [...blockMembers.entries()].sort((a, b) => a[0] - b[0]).map(([id, pcs]) => {
    const normalizedSeed = (seed >>> 0) % OPERAND_MODULUS;
    let hashA = (normalizedSeed + protoSalt * 97 + id * 31) % OPERAND_MODULUS;
    let hashB = (normalizedSeed * 65599 + protoSalt * 131 + id * 257) % OPERAND_MODULUS;
    const mixBlock = (value: number) => {
      hashA = (hashA * 33 + value) % OPERAND_MODULUS;
      hashB = (hashB * 65599 + value * 17 + (hashA % 65521)) % OPERAND_MODULUS;
    };
    for (const pc of pcs) {
      mixBlock(pc);
      for (const value of encodedCode[pc - 1]) mixBlock(value);
    }
    return [hashA, hashB, ...pcs];
  });
  const blockDescriptors = blockDescriptorValues.map((values) => '{' + values.join(',') + '}').join(',');
  const upvalueValues = p.upvals.map((d) => [d.fromLocal ? 1 : 0, d.index]);
  const seal = protoSeal(encodedCode, seed, protoSalt, p.nparams, p.nslots, p.isVararg, blockMap, blockDescriptorValues, p.consts.length, p.protos.length, upvalueValues);
  const code = encodedCode.map((fields) => '{' + fields.join(',') + '}').join(',');
  const consts = p.consts.map((value) => luaConst(value, seed, stringIndex)).join(',');
  const upvals = p.upvals.map((d) => `{${d.fromLocal ? 1 : 0},${d.index}}`).join(',');
  const children = p.protos.map((c) => serializeProto(c, ops, keys, seed, stringIndex, protoCounter)).join(',');
  return `{${keys.salt}=${protoSalt},${keys.seal}={${seal.join(',')}},${keys.blockmap}={${blockMap.join(',')}},${keys.blocks}={${blockDescriptors}},${keys.np}=${p.nparams},${keys.ns}=${p.nslots},${keys.va}=${p.isVararg ? 'true' : 'false'},${keys.code}={${code}},${keys.constants}={${consts}},${keys.children}={${children}},${keys.upvalues}={${upvals}}}`;
}

/**
 * Plantilla del intérprete. Los identificadores OP_<NOMBRE> se sustituyen por
 * los códigos aleatorios de cada build. Sólo usa construcciones válidas en
 * Luau y en Lua 5.4 (sin goto, continue, operadores de bits ni "//").
 */
const TEMPLATE = String.raw`
local strlib, tbl, floor = string, table, math.floor
local unpackfn = (tbl and tbl.unpack) or unpack
local function unstr(bytes, key)
  local out = {}
  local state = key
  for i = 1, #bytes do
    state = (state * 73 + 41) % 256
    out[i] = strlib.char((bytes[i] - state - i * 17) % 256)
  end
  return tbl.concat(out)
end
local function unnum(bytes, key)
  local decoded = {}
  local state = key
  for i = 1, #bytes do
    state = (state * 73 + 41) % 256
    decoded[i] = (bytes[i] - state - i * 29) % 256
  end
  local sign = floor(decoded[8] / 128)
  local exponent = (floor(decoded[8] / 16) % 8) * 256 + floor(decoded[7] / 16)
  local mantissa = (decoded[7] % 16) * 2^48 + decoded[6] * 2^40 + decoded[5] * 2^32
    + decoded[4] * 2^24 + decoded[3] * 2^16 + decoded[2] * 2^8 + decoded[1]
  if exponent == 2047 then
    if mantissa == 0 then return sign == 1 and (-1/0) or (1/0) end
    return (0/0)
  end
  local value
  if exponent == 0 then
    value = (mantissa / 2^52) * 2^-1022
  else
    value = (1 + mantissa / 2^52) * 2^(exponent - 1023)
  end
  return sign == 1 and -value or value
end
local typefn, select, setmt, getmt, errorfn, pcallfn = type, select, setmetatable, getmetatable, error, pcall
local rawgetfn, rawsetfn = rawget, rawset
local getenv, getgenvfn = getfenv, getgenv
local baseEnv = (getenv and getenv(0)) or _G
local executorEnv = baseEnv
if getgenvfn then
  local ok, candidate = pcallfn(getgenvfn)
  if ok and typefn(candidate) == "table" then executorEnv = candidate end
end
-- Blindaje de introspección: el programa virtual no recibe acceso directo a
-- tablas de entorno, registros internos ni primitivas típicas de hooking.
-- Esto reduce fugas accidentales; no puede neutralizar un executor que ya
-- controla el proceso, parchea el runtime o inspecciona memoria.
local BLOCKED_ENV = {
  debug=true, getfenv=true, getgenv=true, getrenv=true, getreg=true, getgc=true,
  hookfunction=true, hookmetamethod=true, getrawmetatable=true, setreadonly=true,
  getconnections=true, getupvalues=true, getconstants=true, getproto=true,
  getprotos=true, getscriptbytecode=true, getsenv=true, getloadedmodules=true,
  getrunningscripts=true, identifyexecutor=true, getexecutorname=true, checkcaller=true,
}
-- Resolver globals mediante un proxy privado; no se devuelve ninguna tabla
-- de entorno y las lecturas del executor evitan sus metamétodos __index.
local ENV = setmt({}, {
  __index = function(_, key)
    if BLOCKED_ENV[key] then return nil end
    local value = rawgetfn(executorEnv, key)
    if value ~= nil then return value end
    value = rawgetfn(baseEnv, key)
    if value ~= nil then return value end
    return baseEnv[key]
  end,
  __newindex = function(_, key, value)
    if BLOCKED_ENV[key] then errorfn("acceso de entorno bloqueado", 0) end
    rawsetfn(executorEnv, key, value)
  end,
})
local STEP_LIMIT = __LIMIT__
local VALID_OP = __VALID_OPS__
local OPERAND_MODULUS, OPERAND_HALF = 2147483647, 1073741823
local OPERAND_SEED = __OPERAND_SEED__
local function protoIntact(P)
  local hashA = (OPERAND_SEED + P.__KEY_SALT__ * 97 + P.__KEY_NP__ * 17 + P.__KEY_NS__ * 31 + (P.__KEY_VA__ and 1 or 0)) % OPERAND_MODULUS
  local hashB = (OPERAND_SEED * 65599 + P.__KEY_SALT__ * 131 + P.__KEY_NP__ * 257 + P.__KEY_NS__ * 911 + (P.__KEY_VA__ and 17 or 0)) % OPERAND_MODULUS
  local function mix(value)
    hashA = (hashA * 33 + value) % OPERAND_MODULUS
    hashB = (hashB * 65599 + value * 17 + (hashA % 65521)) % OPERAND_MODULUS
  end
  local code = P.__KEY_CODE__
  if typefn(code) ~= "table" then return false end
  for i = 1, #code do
    local ins = code[i]
    if typefn(ins) ~= "table" or #ins ~= 9 then return false end
    for j = 1, 9 do
      local value = ins[j]
      if typefn(value) ~= "number" or value ~= floor(value) then return false end
      mix(value)
    end
  end
  local blockMap, blocks = P.__KEY_BLOCKMAP__, P.__KEY_BLOCKS__
  local constants, children, upvalues = P.__KEY_CONST__, P.__KEY_CHILD__, P.__KEY_UP__
  if typefn(blockMap) ~= "table" or typefn(blocks) ~= "table" or typefn(constants) ~= "table"
    or typefn(children) ~= "table" or typefn(upvalues) ~= "table" then return false end
  for i = 1, #blockMap do
    local value = blockMap[i]
    if typefn(value) ~= "number" or value ~= floor(value) then return false end
    mix(value)
  end
  for i = 1, #blocks do
    local descriptor = blocks[i]
    if typefn(descriptor) ~= "table" then return false end
    for j = 1, #descriptor do
      local value = descriptor[j]
      if typefn(value) ~= "number" or value ~= floor(value) then return false end
      mix(value)
    end
  end
  mix(#constants)
  mix(#children)
  mix(#upvalues)
  for i = 1, #upvalues do
    local descriptor = upvalues[i]
    if typefn(descriptor) ~= "table" or #descriptor ~= 2 then return false end
    for j = 1, 2 do
      local value = descriptor[j]
      if typefn(value) ~= "number" or value ~= floor(value) then return false end
      mix(value)
    end
  end
  local seal = P.__KEY_SEAL__
  return typefn(seal) == "table" and #seal == 2 and hashA == seal[1] and hashB == seal[2]
end
local function instructionIntact(ins, pc, protoSalt)
  if typefn(ins) ~= "table" or #ins ~= 9 then return false end
  local hashA = (OPERAND_SEED + protoSalt * 97 + pc * 31) % OPERAND_MODULUS
  local hashB = (OPERAND_SEED * 65599 + protoSalt * 131 + pc * 257) % OPERAND_MODULUS
  for i = 1, 7 do
    local value = ins[i]
    if typefn(value) ~= "number" or value ~= floor(value) then return false end
    hashA = (hashA * 33 + value) % OPERAND_MODULUS
    hashB = (hashB * 65599 + value * 17 + (hashA % 65521)) % OPERAND_MODULUS
  end
  return typefn(ins[8]) == "number" and typefn(ins[9]) == "number"
    and ins[8] == floor(ins[8]) and ins[9] == floor(ins[9])
    and hashA == ins[8] and hashB == ins[9]
end
local function blockIntact(P, blockId)
  local descriptor = P.__KEY_BLOCKS__[blockId]
  if typefn(descriptor) ~= "table" or #descriptor < 3 then return false end
  local hashA = (OPERAND_SEED + P.__KEY_SALT__ * 97 + blockId * 31) % OPERAND_MODULUS
  local hashB = (OPERAND_SEED * 65599 + P.__KEY_SALT__ * 131 + blockId * 257) % OPERAND_MODULUS
  local function mixBlock(value)
    hashA = (hashA * 33 + value) % OPERAND_MODULUS
    hashB = (hashB * 65599 + value * 17 + (hashA % 65521)) % OPERAND_MODULUS
  end
  for j = 3, #descriptor do
    local pc = descriptor[j]
    if typefn(pc) ~= "number" or pc < 1 or pc > #P.__KEY_CODE__ or P.__KEY_BLOCKMAP__[pc] ~= blockId then return false end
    local ins = P.__KEY_CODE__[pc]
    if typefn(ins) ~= "table" or #ins ~= 9 then return false end
    mixBlock(pc)
    for k = 1, 9 do
      local value = ins[k]
      if typefn(value) ~= "number" or value ~= floor(value) then return false end
      mixBlock(value)
    end
  end
  return hashA == descriptor[1] and hashB == descriptor[2]
end
local function constant(P, index)
  local value = P.__KEY_CONST__[index]
  if typefn(value) == "function" then return value() end
  return value
end
local function decodeOperand(value, pc, field, protoSalt)
  local mask = (OPERAND_SEED + pc * 131 + field * 977 + protoSalt * 4099 + (pc * field * protoSalt * 17) % OPERAND_MODULUS) % OPERAND_MODULUS
  local decoded = (value - mask) % OPERAND_MODULUS
  if decoded > OPERAND_HALF then decoded = decoded - OPERAND_MODULUS end
  return decoded
end
local steps, curLine, depth = 0, 0, 0
local function fail(msg) errorfn("línea " .. curLine .. ": " .. msg, 0) end
local MULTI = {}
local function multi(n) return setmt({n = n}, MULTI) end
local function isMulti(v) return typefn(v) == "table" and getmt(v) == MULTI end
local function pack(...) return {n = select("#", ...), ...} end
local function index(o, k)
  local t = typefn(o)
  if t == "table" then return o[k] end
  if t == "string" then return strlib[k] end
  -- Roblox Instances, userdata y objetos con __index deben usar el acceso nativo.
  return o[k]
end
local run
local function callv(f, args)
  -- La llamada directa conserva __call para tablas/objetos invocables de Luau.
  return pack(f(unpackfn(args, 1, args.n)))
end
local function makeClosure(child, cells)
  return function(...)
    local res = run(child, cells, pack(...))
    return unpackfn(res, 1, res.n)
  end
end
run = function(P, U, args)
  depth = depth + 1
  if depth > 200 then depth = depth - 1; fail("stack overflow") end
  -- Asegura que depth se restaure incluso si el script captura un error con pcall.
  local ok, result = pcallfn(function()
  local slots = {}
  local np = P.__KEY_NP__
  local ns = P.__KEY_NS__
  if not protoIntact(P) then fail("integridad comprometida: prototipo alterado") end
  if typefn(np) ~= "number" or typefn(ns) ~= "number" or np < 0 or np > ns or np ~= floor(np) or ns ~= floor(ns) then fail("prototipo corrupto") end
  for i = 1, np do slots[i] = args[i] end
  local va, nva = {}, 0
  if P.__KEY_VA__ then
    for i = np + 1, args.n do nva = nva + 1; va[nva] = args[i] end
  end
  local st, sp = {}, 0
  local code, pc = P.__KEY_CODE__, 1
  local activeBlock = 0
  if typefn(P.__KEY_BLOCKMAP__) ~= "table" or #P.__KEY_BLOCKMAP__ ~= #code or typefn(P.__KEY_BLOCKS__) ~= "table" then fail("índice de bloques corrupto") end
  local protoSalt = P.__KEY_SALT__
  local function push(v)
    sp = sp + 1
    if sp > 100000 then fail("límite de pila superado") end
    st[sp] = v
  end
  local function pop()
    if sp < 1 then fail("pila vacía") end
    local v = st[sp]
    st[sp] = nil
    sp = sp - 1
    return v
  end
  local function popN(k)
    local out = {n = k}
    if typefn(k) ~= "number" or k < 0 or k ~= floor(k) or k > sp then fail("lectura de pila fuera de rango") end
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
    local ip = pc
    local ins = code[ip]
    local blockId = P.__KEY_BLOCKMAP__[ip]
    if typefn(blockId) ~= "number" or blockId < 1 or blockId ~= floor(blockId) then fail("bloque virtual inválido") end
    if blockId ~= activeBlock then
      if not blockIntact(P, blockId) then fail("integridad comprometida: bloque virtual alterado") end
      activeBlock = blockId
    end
    if not ins then fail("bytecode truncado o alterado") end
    -- Comprueba la forma del registro antes de decodificarlo; evita que una
    -- salida truncada o manipulada termine en errores opacos de indexación.
    if typefn(ins) ~= "table" or #ins ~= 9 then fail("instrucción corrupta") end
    if not instructionIntact(ins, ip, protoSalt) then fail("integridad comprometida: instrucción alterada") end
    for field = 1, 9 do
      local value = ins[field]
      if typefn(value) ~= "number" or value ~= floor(value) then fail("operando corrupto") end
    end
    local op = decodeOperand(ins[1], ip, 1, protoSalt)
    local a = decodeOperand(ins[2], ip, 2, protoSalt)
    local b = decodeOperand(ins[3], ip, 3, protoSalt)
    local t = decodeOperand(ins[4], ip, 4, protoSalt)
    local c = decodeOperand(ins[5], ip, 5, protoSalt) == 1
    pc = decodeOperand(ins[7], ip, 7, protoSalt)
    if pc < 0 or pc > #code then fail('sucesora fuera del prototipo') end
    if not VALID_OP[op] then fail("opcode inválido") end
    if (op == OP_GETL or op == OP_SETL or op == OP_NEWBOX or op == OP_GETBOX or op == OP_SETBOX or op == OP_BOXSLOT) and (a < 0 or a >= ns) then fail("slot fuera de rango") end
    if op == OP_MOVE and (a < 0 or a >= ns or b < 0 or b >= ns) then fail("slot MOVE fuera de rango") end
    if (op == OP_FORTEST or op == OP_FORSTEP or op == OP_GENCALL) and (a < 0 or a + 2 >= ns) then fail("slot de iterador fuera de rango") end
    if (op == OP_CONST or op == OP_GETG or op == OP_SETG or op == OP_SELF) and (a < 0 or a >= #P.__KEY_CONST__) then fail("constante fuera de rango") end
    if (op == OP_GETUP or op == OP_SETUP) and (a < 0 or a >= #U) then fail("upvalue fuera de rango") end
    if op == OP_CLOSURE and (a < 0 or a >= #P.__KEY_CHILD__) then fail("closure fuera de rango") end
    if (op == OP_JMP or op == OP_JF or op == OP_JFK or op == OP_JTK or op == OP_FORTEST or op == OP_GENCALL)
      and (t < 1 or t > #code) then fail("salto fuera del prototipo") end
    steps = steps + 1
    if steps > STEP_LIMIT then fail("límite de ejecución superado") end
    local lineToken = decodeOperand(ins[6], ip, 6, protoSalt)
    local lineMultiplier = 17 + ((OPERAND_SEED + protoSalt * 131) % 31)
    local lineOffset = (OPERAND_SEED + protoSalt * 65537) % 1000003
    curLine = floor((lineToken - lineOffset) / lineMultiplier)
    if op == OP_CONST then push(constant(P, a + 1))
    elseif op == OP_NIL then push(nil)
    elseif op == OP_TRUE then push(true)
    elseif op == OP_FALSE then push(false)
    elseif op == OP_POP then pop()
    elseif op == OP_GETL then push(slots[a + 1])
    elseif op == OP_SETL then slots[a + 1] = pop()
    elseif op == OP_MOVE then slots[b + 1] = slots[a + 1]
    elseif op == OP_NEWBOX then slots[a + 1] = {v = pop()}
    elseif op == OP_BOXSLOT then slots[a + 1] = {v = slots[a + 1]}
    elseif op == OP_GETBOX then push(slots[a + 1].v)
    elseif op == OP_SETBOX then slots[a + 1].v = pop()
    elseif op == OP_GETUP then push(U[a + 1].v)
    elseif op == OP_SETUP then U[a + 1].v = pop()
    elseif op == OP_GETG then push(ENV[constant(P, a + 1)])
    elseif op == OP_SETG then ENV[constant(P, a + 1)] = pop()
    elseif op == OP_GETI then
      local k = pop()
      local o = pop()
      push(index(o, k))
    elseif op == OP_SETI then
      local v = pop()
      local k = pop()
      local o = pop()
      -- Permite propiedades de Instance y asignaciones vía __newindex.
      o[k] = v
    elseif op == OP_SELF then
      local o = pop()
      push(index(o, constant(P, a + 1)))
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
      return out
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
      local child = P.__KEY_CHILD__[a + 1]
      local cells = {}
      for i, d in ipairs(child.__KEY_UP__) do
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
  end)
  depth = depth - 1
  if not ok then errorfn(result, 0) end
  return result
end
local MAIN = __MAIN__
local function main(...)
  local res = run(MAIN, {}, pack(...))
  return unpackfn(res, 1, res.n)
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
  const keys = protoKeys(seed);
  const keyValues: Record<string, string> = { NP: keys.np, NS: keys.ns, VA: keys.va, CODE: keys.code, CONST: keys.constants, CHILD: keys.children, UP: keys.upvalues, SALT: keys.salt, SEAL: keys.seal, BLOCKMAP: keys.blockmap, BLOCKS: keys.blocks };
  body = body.replace(/__KEY_(NP|NS|VA|CODE|CONST|CHILD|UP|SALT|SEAL|BLOCKMAP|BLOCKS)__/g, (_m, name: string) => keyValues[name]);
  body = body.replace('__LIMIT__', String(limit));
  body = body.replace('__VALID_OPS__', '{' + ALL_OPS.map((op) => '[' + ops[op] + ']=true').join(',') + '}');
  body = body.replace('__OPERAND_SEED__', String((seed >>> 0) % OPERAND_MODULUS));
  body = body.replace('__MAIN__', serializeProto(main, ops, keys, seed, { value: 0 }, { value: 0 }));
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
