/** Utilidades puras para la vista de trabajos y estadísticas. */
export const STATUS_LABEL: Record<string, string> = {
  queued: 'En cola',
  running: 'Procesando',
  done: 'Completado',
  failed: 'Fallido',
  timeout: 'Tiempo agotado',
};

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

/** Etapa visible del procesamiento a partir del estado del trabajo y el tiempo transcurrido. */
export function progressStep(status: string): { label: string; percent: number } {
  switch (status) {
    case 'queued': return { label: 'En cola', percent: 10 };
    case 'running': return { label: 'Ofuscando (parser, transformaciones, verificación)', percent: 60 };
    case 'done': return { label: 'Listo', percent: 100 };
    default: return { label: STATUS_LABEL[status] ?? status, percent: 100 };
  }
}
