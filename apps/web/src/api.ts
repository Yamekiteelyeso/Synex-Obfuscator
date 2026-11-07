/** Cliente HTTP de la API de Synex. El token se guarda en localStorage del navegador. */
export const TOKEN_KEY = 'synex.token';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `error ${res.status}`, data?.error?.code);
  return data as T;
}

export async function downloadCode(jobId: string, token: string): Promise<Blob> {
  const res = await fetch(`/api/jobs/${jobId}/code`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, 'no se pudo descargar el resultado');
  return res.blob();
}
