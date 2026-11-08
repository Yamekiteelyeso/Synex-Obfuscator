import React from 'react';
import { formatDate } from '../state';

export interface AdminData {
  users: { id: string; discordId?: string; discordUsername?: string; role: string; plan: 'free' | 'premium' | 'plus'; obfuscationsUsed: number; obfuscationLimit: number | null; createdAt: number }[];
  jobs: { id: string; fileName: string; status: string; createdAt: number }[];
  errors: { at: number; method: string; path: string; message: string }[];
  settings: { maxInputBytes: number; enabledProfiles: string[] };
}

export function Admin({ data, onToggleProfile, onSetUserPlan }: {
  data: AdminData | null;
  onToggleProfile: (p: string, on: boolean) => void;
  onSetUserPlan: (userId: string, plan: 'free' | 'premium' | 'plus') => void;
}) {
  if (!data) return <p className="muted">Cargando administración…</p>;
  const all = ['basic', 'medium', 'max'];
  return (
    <section className="view">
      <h2>Administración</h2>
      <div className="two-col">
        <div className="card">
          <h3>Perfiles de ofuscación</h3>
          {all.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={data.settings.enabledProfiles.includes(p)} onChange={(e: any) => onToggleProfile(p, e.target.checked)} />
              {p}
            </label>
          ))}
          <p className="muted">Tamaño máximo: {Math.round(data.settings.maxInputBytes / 1024)} KB</p>
        </div>
        <div className="card">
          <h3>Cuentas ({data.users.length})</h3>
          <ul className="plain-list">
            {data.users.map((u) => (
              <li key={u.id}>
                <span>{u.discordUsername ? '@' + u.discordUsername : u.id}</span>
                <small>{u.role} · {u.plan.toUpperCase()} · {u.obfuscationsUsed} usos{u.obfuscationLimit === null ? '' : ` / ${u.obfuscationLimit}`} · {formatDate(u.createdAt)}</small>
                <label className="admin-plan-control">Asignar plan
                  <select value={u.plan} onChange={(e: any) => onSetUserPlan(u.id, e.target.value)}>
                    <option value="free">Free</option>
                    <option value="premium">Premium</option>
                    <option value="plus">Plus (Max)</option>
                  </select>
                </label>
              </li>
            ))}
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
