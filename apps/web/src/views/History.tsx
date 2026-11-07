import React from 'react';
import { formatDate, formatDuration, STATUS_LABEL } from '../state';

export interface HistoryEntry {
  id: string; fileName: string; profile: string; status: string;
  createdAt: number; durationMs?: number; error?: { message: string }; equivalence?: string;
}

export function History({ jobs }: { jobs: HistoryEntry[] | null }) {
  if (jobs === null) return <p className="muted">Cargando historial…</p>;
  return (
    <section className="view">
      <h2>Historial</h2>
      {jobs.length === 0 ? <p className="muted">No hay trabajos todavía.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Archivo</th><th>Perfil</th><th>Estado</th><th>Duración</th><th>Detalle</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{formatDate(j.createdAt)}</td>
                  <td>{j.fileName}</td>
                  <td>{j.profile}</td>
                  <td><span className={`badge ${j.status}`}>{STATUS_LABEL[j.status] ?? j.status}</span></td>
                  <td>{formatDuration(j.durationMs)}</td>
                  <td className="error-text">{j.error?.message ?? (j.equivalence ? `equivalencia: ${j.equivalence}` : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
