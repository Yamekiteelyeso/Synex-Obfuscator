/** Errores de compilación con posición en el código fuente. */
export class SynexError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
    public readonly code: string = 'E_GENERIC',
  ) {
    super(`${line}:${column} ${message}`);
    this.name = 'SynexError';
  }
}

export interface Position { line: number; column: number; offset: number; }
