import React from 'react';
import { formatDate } from '../state';

export interface AdminData {
  users: { id: string; discordUsername?: string; role: string; plan: string; obfuscationsUsed: number; obfuscationLimit: number | null; createdAt: number }[];
  jobs: { id: string; fileName: string; status: string; createdAt: number }[];
  errors: { at: number; method: string; path: string; message: string }[];
  planRequests: { id: string; userId: string; discordUsername: string; plan: 'premium' | 'plus'; status: 'pending' | 'approved' | 'rejected'; createdAt: number }[];
  settings: { maxInputBytes: number; enabledProfiles: string[] };
}

export function Admin({ data, onToggleProfile, onUpdateRequest }: {
  data: AdminData | null;
  onToggleProfile: (p: string, on: boolean) => void;
  onUpdateRequest: (id: string, status: 'approved' | 'rejected') => void;
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
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card">
        <h3>Solicitudes de planes</h3>
        {data.planRequests.length === 0 ? <p className="muted">No hay solicitudes.</p> : (
          <ul className="plain-list plan-request-list">
            {data.planRequests.map((request) => (
              <li key={request.id}>
                <span>@{request.discordUsername} solicita <b>{request.plan.toUpperCase()}</b></span>
                <small>{request.status.toUpperCase()} · {formatDate(request.createdAt)}</small>
                {request.status === 'pending' && (
                  <div className="plan-request-actions">
                    <button className="btn primary" onClick={() => onUpdateRequest(request.id, 'approved')}>Aprobar tras confirmar el pago</button>
                    <button className="btn" onClick={() => onUpdateRequest(request.id, 'rejected')}>Rechazar</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">La aprobación asigna el plan a la cuenta. Confirma el pago por tu canal de venta antes de aprobar; aquí no se procesan tarjetas.</p>
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
