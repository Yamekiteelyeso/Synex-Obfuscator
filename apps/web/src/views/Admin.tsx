import React from 'react';
import { formatDate } from '../state';

export interface AdminData {
  users: { id: string; email: string; role: string; createdAt: number }[];
  jobs: { id: string; fileName: string; status: string; createdAt: number }[];
  errors: { at: number; method: string; path: string; message: string }[];
  settings: { maxInputBytes: number; enabledProfiles: string[] };
}

export function Admin({ data, onToggleProfile }: { data: AdminData | null; onToggleProfile: (p: string, on: boolean) => void }) {
  if (!data) return <p className="muted">Cargando panel de administración…</p>;
  const all = ['basic', 'medium', 'max'];
  return (
    <section className="view">
      <h2>Administración</h2>
      <div className="two-col">
        <div className="card">
          <h3>Planes disponibles</h3>
          {all.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={data.settings.enabledProfiles.includes(p)} onChange={(e: any) => onToggleProfile(p, e.target.checked)} />
              {p}
            </label>
          ))}
          <p className="muted">Tamaño máximo: {Math.round(data.settings.maxInputBytes / 1024)} KB</p>
        </div>
        <div className="card">
          <h3>Usuarios ({data.users.length})</h3>
          <ul className="plain-list">
            {data.users.map((u) => <li key={u.id}><span>{u.email}</span><small>{u.role} · {formatDate(u.createdAt)}</small></li>)}
          </ul>
        </div>
      </div>
      <div className="card">
        <h3>Errores registrados</h3>
        {data.errors.length === 0 ? <p className="muted">Ninguno.</p> : (
          <ul className="plain-list">
            {data.errors.map((e, i) => <li key={i}><span>{e.method} {e.path}</span><small className="error-text">{e.message} · {formatDate(e.at)}</small></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
