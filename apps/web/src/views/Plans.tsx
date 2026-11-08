import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { SessionUser } from './Auth';

type PlanRequest = { id: string; plan: 'premium' | 'plus'; status: 'pending' | 'approved' | 'rejected'; createdAt: number };
type PlanId = 'free' | 'premium' | 'plus';

const PLANS: { id: PlanId; label: string; price: string; description: string; features: string[] }[] = [
  { id: 'free', label: 'Free', price: 'Gratis', description: 'Empieza a proteger tus scripts.', features: ['2 ofuscaciones totales', 'Perfil Basic', 'Cuenta vinculada a Discord'] },
  { id: 'premium', label: 'Premium', price: 'Consultar precio', description: 'Para trabajar con más transformaciones.', features: ['Ofuscaciones ilimitadas', 'Perfiles Basic y Medium', 'Solicitudes y soporte de upgrade'] },
  { id: 'plus', label: 'Plus', price: 'Consultar precio', description: 'Todas las herramientas de Synex.', features: ['Ofuscaciones ilimitadas', 'Basic, Medium y Max', 'VM y protección avanzada de Max'] },
];

export function Plans({ token, user, onRefresh }: { token: string; user: SessionUser; onRefresh: () => Promise<void> }) {
  const [requests, setRequests] = useState<PlanRequest[]>([]);
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ requests: PlanRequest[] }>('GET', '/api/plan-requests', undefined, token)
      .then((result) => setRequests(result.requests))
      .catch(() => setMessage('No se pudieron cargar tus solicitudes.'));
  }, [token]);

  async function requestPlan(plan: Exclude<PlanId, 'free'>) {
    setBusy(plan); setMessage(null);
    try {
      const result = await api<{ request: PlanRequest }>('POST', '/api/plan-requests', { plan }, token);
      setRequests((current) => [result.request, ...current.filter((entry) => entry.id !== result.request.id)]);
      setMessage('Solicitud guardada. El administrador confirmará el pago y activará tu plan.');
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'No se pudo guardar la solicitud.');
    } finally {
      setBusy(null);
    }
  }

  const latest = (plan: Exclude<PlanId, 'free'>) => requests.find((request) => request.plan === plan && request.status === 'pending');
  return (
    <section className="view">
      <div className="editor-heading">
        <div><p className="eyebrow">SYNEX MEMBERSHIP</p><h2>Planes</h2><p className="muted">Elige el nivel de acceso que necesitas. Tu plan queda vinculado a tu cuenta de Discord.</p></div>
        <span className="editor-tag">PLAN ACTUAL · {user.plan.toUpperCase()}</span>
      </div>
      <div className="plans-grid">
        {PLANS.map((plan) => {
          const current = user.plan === plan.id;
          const pending = plan.id !== 'free' && latest(plan.id);
          const unavailable = plan.id === 'free' || current || user.plan === 'plus' || Boolean(pending);
          return (
            <article className={`plan-card ${plan.id === 'plus' ? 'plan-featured' : ''} ${current ? 'plan-current' : ''}`} key={plan.id}>
              <div className="plan-card-top"><span>{plan.id === 'plus' ? 'MÁXIMO ACCESO' : plan.id === 'premium' ? 'PARA CREADORES' : 'EMPIEZA GRATIS'}</span>{current && <b>ACTUAL</b>}</div>
              <h3>{plan.label}</h3>
              <strong className="plan-price">{plan.price}</strong>
              <p className="muted">{plan.description}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              {current ? <button className="btn" disabled>Tu plan actual</button>
                : plan.id === 'free' ? <button className="btn" disabled>Plan gratuito</button>
                : <button className={`btn ${plan.id === 'plus' ? 'primary' : ''}`} disabled={unavailable || busy !== null} onClick={() => void requestPlan(plan.id)}>
                    {busy === plan.id ? 'Enviando…' : pending ? 'Solicitud pendiente' : user.plan === 'plus' ? 'Ya tienes Plus' : `Solicitar ${plan.label}`}
                  </button>}
            </article>
          );
        })}
      </div>
      <div className="card plan-usage">
        <div><h3>Uso de tu cuenta</h3><p className="muted">Plan {user.plan.toUpperCase()}</p></div>
        <strong>{user.obfuscationLimit === null ? `${user.obfuscationsUsed} · Ilimitado` : `${Math.max(0, user.obfuscationLimit - user.obfuscationsUsed)} de ${user.obfuscationLimit} restantes`}</strong>
      </div>
      {requests.length > 0 && <div className="card"><h3>Tus solicitudes</h3><ul className="plain-list">{requests.map((request) => <li key={request.id}><span>{request.plan.toUpperCase()}</span><small>{request.status === 'pending' ? 'Pendiente de pago / revisión' : request.status === 'approved' ? 'Aprobada' : 'Rechazada'} · {new Date(request.createdAt).toLocaleDateString('es-MX')}</small></li>)}</ul></div>}
      {message && <p className="muted" role="status">{message}</p>}
      <p className="muted plan-payment-note">El precio final y el pago se coordinan con el administrador. Esta versión registra solicitudes, pero no procesa tarjetas ni pagos automáticamente.</p>
    </section>
  );
}
