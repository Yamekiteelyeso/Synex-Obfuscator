import React from 'react';
import type { SessionUser } from './Auth';

type PlanId = 'free' | 'premium' | 'plus';

const PLANS: { id: PlanId; label: string; price: string; description: string; features: string[] }[] = [
  { id: 'free', label: 'Free', price: 'Gratis', description: 'Empieza a proteger tus scripts.', features: ['2 ofuscaciones totales', 'Perfil Basic', 'Cuenta vinculada a Discord'] },
  { id: 'premium', label: 'Premium', price: 'Consultar precio', description: 'Para trabajar con más transformaciones.', features: ['Ofuscaciones ilimitadas', 'Perfiles Basic y Medium', 'Soporte de upgrade'] },
  { id: 'plus', label: 'Plus', price: 'Consultar precio', description: 'Todas las herramientas de Synex.', features: ['Ofuscaciones ilimitadas', 'Basic, Medium y Max', 'VM y protección avanzada de Max'] },
];

export function Plans({ user }: { token: string; user: SessionUser; onRefresh: () => Promise<void> }) {
  const contactAdmin = () => window.alert('Contact one admin for buy');

  return (
    <section className="view">
      <div className="editor-heading">
        <div><p className="eyebrow">SYNEX MEMBERSHIP</p><h2>Planes</h2><p className="muted">Los upgrades se gestionan directamente con un administrador.</p></div>
        <span className="editor-tag">PLAN ACTUAL · {user.plan.toUpperCase()}</span>
      </div>
      <div className="plans-grid">
        {PLANS.map((plan) => {
          const current = user.plan === plan.id;
          return (
            <article className={`plan-card ${plan.id === 'plus' ? 'plan-featured' : ''} ${current ? 'plan-current' : ''}`} key={plan.id}>
              <div className="plan-card-top"><span>{plan.id === 'plus' ? 'MÁXIMO ACCESO' : plan.id === 'premium' ? 'PARA CREADORES' : 'EMPIEZA GRATIS'}</span>{current && <b>ACTUAL</b>}</div>
              <h3>{plan.label}</h3>
              <strong className="plan-price">{plan.price}</strong>
              <p className="muted">{plan.description}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              {current ? <button className="btn" disabled>Tu plan actual</button>
                : plan.id === 'free' ? <button className="btn" disabled>Plan gratuito</button>
                : <button className={`btn ${plan.id === 'plus' ? 'primary' : ''}`} onClick={contactAdmin}>Contact one admin for buy</button>}
            </article>
          );
        })}
      </div>
      <div className="card plan-usage">
        <div><h3>Uso de tu cuenta</h3><p className="muted">Plan {user.plan.toUpperCase()}</p></div>
        <strong>{user.obfuscationLimit === null ? `${user.obfuscationsUsed} · Ilimitado` : `${Math.max(0, user.obfuscationLimit - user.obfuscationsUsed)} de ${user.obfuscationLimit} restantes`}</strong>
      </div>
      <p className="muted plan-payment-note">Los planes Premium y Plus se activan manualmente por un administrador después de confirmar la compra.</p>
    </section>
  );
}
