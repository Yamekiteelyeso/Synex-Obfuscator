/** Valores de Luau en el intérprete de referencia. nil = undefined. */
export type Value = undefined | boolean | number | string | LuaTable | LuaFunction;

/** Error de ejecución de Luau (equivale a un error() no capturado). */
export class LuaError extends Error {
  constructor(message: string, public readonly line = 0, public readonly column = 0) {
    super(message);
    this.name = 'LuaError';
  }
}

export class LuaTable {
  readonly hash = new Map<Value, Value>();
  private frozen = false;

  get isFrozen(): boolean {
    return this.frozen;
  }

  freeze(): this {
    if (this.frozen) throw new LuaError('table is already frozen');
    this.frozen = true;
    return this;
  }

  clearContents(): void {
    if (this.frozen) throw new LuaError('attempt to modify a frozen table');
    this.hash.clear();
  }

  get(key: Value): Value {
    return key === undefined ? undefined : this.hash.get(key);
  }

  set(key: Value, value: Value): void {
    if (this.frozen) throw new LuaError('attempt to modify a frozen table');
    if (key === undefined) throw new LuaError('index is nil');
    if (typeof key === 'number' && Number.isNaN(key)) throw new LuaError('index is NaN');
    if (value === undefined) this.hash.delete(key);
    else this.hash.set(key, value);
  }

  /** Longitud por borde: n tal que t[1..n] existen. */
  length(): number {
    let n = 0;
    while (this.hash.has(n + 1)) n++;
    return n;
  }
}

export abstract class LuaFunction {
  abstract call(args: Value[]): Value[];
}

export class NativeFunction extends LuaFunction {
  constructor(private readonly fn: (args: Value[]) => Value[]) {
    super();
  }

  call(args: Value[]): Value[] {
    return this.fn(args);
  }
}
