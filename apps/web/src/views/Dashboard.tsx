import React from 'react';
import { formatDate, formatDuration, STATUS_LABEL } from '../state';

export interface Stats {
  totalJobs: number;
  byStatus: Record<string, number>;
  perProfile: Record<string, number>;
  averageProcessingMs: number | null;
  latest: { id: string; fileName: string; profile: string; status: string; createdAt: number }[];
  recentErrors: { id: string; fileName: string; message: string }[];
}

export function Dashboard({ stats, health, email }: { stats: Stats | null; health: any; email: string }) {
  if (!stats) return <p className="muted">Cargando métricas…</p>;
  const done = stats.byStatus.done ?? 0;
  const failed = (stats.byStatus.failed ?? 0) + (stats.byStatus.timeout ?? 0);
  return (
    <section className="view">
      <h2>Panel</h2>
      <p className="muted">Cuenta: {email}</p>
      <div className="kpi-grid">
        <Kpi label="Trabajos totales" value={String(stats.totalJobs)} />
        <Kpi label="Completados" value={String(done)} />
        <Kpi label="Con error" value={String(failed)} />
        <Kpi label="Tiempo medio" value={formatDuration(stats.averageProcessingMs)} />
        <Kpi label="Motor" value={health ? `${health.engine.running} activos · ${health.engine.queued} en cola` : 'sin conexión'} />
      </div>
      <div className="two-col">
        <div className="card">
          <h3>Uso por perfil</h3>
          {Object.keys(stats.perProfile).length === 0 && <p className="muted">Aún no has ofuscado nada.</p>}
          <ul className="bars">
            {Object.entries(stats.perProfile).map(([p, n]) => (
              <li key={p}><span>{p}</span><div className="bar"><i style={{ width: `${Math.round((n / stats.totalJobs) * 100)}%` }} /></div><b>{n}</b></li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>Últimos trabajos</h3>
          {stats.latest.length === 0 && <p className="muted">Sin trabajos todavía.</p>}
          <ul className="plain-list">
            {stats.latest.map((j) => (
              <li key={j.id}><span>{j.fileName}</span><small>{j.profile} · {STATUS_LABEL[j.status] ?? j.status} · {formatDate(j.createdAt)}</small></li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card">
        <h3>Errores recientes</h3>
        {stats.recentErrors.length === 0 ? <p className="muted">Ninguno.</p> : (
          <ul className="plain-list">
            {stats.recentErrors.map((e) => <li key={e.id}><span>{e.fileName}</span><small className="error-text">{e.message}</small></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
