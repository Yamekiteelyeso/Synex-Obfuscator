import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ejecución real en Lua 5.4 (no Luau). Luau y Lua 5.4 difieren en sintaxis y
 * biblioteca; estas pruebas sólo usan construcciones comunes a ambos.
 * Las funciones bit32 que usa la cabecera de cadenas se proporcionan aquí.
 */
const PRELUDE = `
bit32 = {
  bxor = function(a, b) return a ~ b end,
  band = function(a, b) return a & b end,
  bor = function(a, b) return a | b end,
  bnot = function(a) return ~a end,
  lshift = function(a, n) return a << n end,
  rshift = function(a, n) return a >> n end,
}
`;

const here = fileURLToPath(new URL('.', import.meta.url));
const BIN = process.env.SYNEX_LUA54 ?? resolve(here, 'lua54run');

export const lua54Available = existsSync(BIN);

export interface LuaRun {
  ok: boolean;
  stdout: string;
  error: string;
}

/** Ejecuta un script en Lua 5.4 y devuelve su salida o el error. */
export function runLua54(code: string): LuaRun {
  const dir = mkdtempSync(join(tmpdir(), 'synex-lua-'));
  const file = join(dir, 'script.lua');
  writeFileSync(file, PRELUDE + '\n' + code, 'utf8');
  const r = spawnSync(BIN, [file], { encoding: 'utf8', timeout: 20_000 });
  if (r.status === 0) return { ok: true, stdout: r.stdout, error: '' };
  return { ok: false, stdout: r.stdout, error: (r.stderr || '').trim() };
}

export function runLua54OrThrow(code: string): string {
  const r = runLua54(code);
  if (!r.ok) throw new Error(`Lua 5.4 falló: ${r.error}`);
  return r.stdout;
}

export { execFileSync };
