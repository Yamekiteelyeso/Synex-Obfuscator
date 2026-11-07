/** Validación del script antes de enviarlo. Devuelve el primer problema o null. */
export function validateSource(source: string, maxBytes: number): string | null {
  if (source.trim() === '') return 'el editor está vacío';
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > maxBytes) return `el script ocupa ${formatBytes(bytes)} y el límite es ${formatBytes(maxBytes)}`;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function countLines(source: string): number {
  return source === '' ? 1 : source.split('\n').length;
}
