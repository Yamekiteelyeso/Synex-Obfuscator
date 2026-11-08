import React from 'react';

export interface SessionUser {
  id: string;
  discordId?: string;
  discordUsername?: string;
  role: string;
  plan: 'free' | 'premium' | 'plus';
  obfuscationsUsed: number;
  obfuscationLimit: number | null;
  allowedProfiles: string[];
  createdAt?: number;
}

export function AuthView({ onAuth }: { onAuth: (token: string, user: SessionUser) => void }) {
  void onAuth;
  return (
    <main className="auth-screen">
      <div className="auth-grid-lines" aria-hidden="true" />
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="brand-mark"><span className="brand-symbol">S</span><span>Synex Obfuscador</span></div>
          <div className="hero-copy">
            <p className="eyebrow"><span className="eyebrow-line" /> PROTECCIÓN DE CÓDIGO LUA / LUAU</p>
            <h1>Synex<br /><span>Obfuscador.</span></h1>
            <p className="auth-lead">Transforma tus scripts con capas de ofuscación, protección de cadenas y una máquina virtual diseñada para trabajar con Luau.</p>
          </div>
          <div className="plan-preview">
            <article><span>01 / GRATIS</span><strong>Free</strong><small>2 ofuscaciones con Basic.</small><i>COMENZAR</i></article>
            <article><span>02 / AVANZADO</span><strong>Premium</strong><small>Uso ilimitado de Basic y Medium.</small><i>UPGRADE</i></article>
            <article><span>03 / COMPLETO</span><strong>Plus</strong><small>Todos los perfiles, incluido Max.</small><i>ACCESO TOTAL</i></article>
          </div>
          <div className="auth-feature-line"><span>CADENA</span><i /><span>FLUJO DE CONTROL</span><i /><span>VM LUAU</span></div>
        </section>
        <section className="auth-card">
          <div className="auth-card-top"><span className="eyebrow">ACCESO A SYNEX</span><span className="status-dot"><b /> MOTOR DISPONIBLE</span></div>
          <h2>Iniciar sesión</h2>
          <p className="muted">Tu cuenta se vincula a tu ID de Discord. No utilizamos cuentas con correo ni contraseñas.</p>
          <a className="btn discord-btn" href="/api/auth/discord" aria-label="Continuar con Discord">
            <svg className="discord-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.7 5.1A18.4 18.4 0 0 0 15.2 3.7l-.6 1.2a17 17 0 0 0-5.2 0l-.6-1.2a18.4 18.4 0 0 0-4.5 1.4C1.5 9.3.7 13.4 1.1 17.4a18.5 18.5 0 0 0 5.5 2.8l1.2-2a11.8 11.8 0 0 1-1.9-.9l.5-.4a13.2 13.2 0 0 0 11.2 0l.5.4a11.8 11.8 0 0 1-1.9.9l1.2 2a18.5 18.5 0 0 0 5.5-2.8c.5-4.6-.8-8.7-3.2-12.3ZM8.6 14.8c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Zm6.8 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Z"/></svg>
            Continuar con Discord <span>↗</span>
          </a>
          <div className="discord-login-steps">
            <span>1. Instala el bot Synex en tu servidor.</span>
            <span>2. Ejecuta <b>/synex-login</b> en Discord.</span>
            <span>3. Abre el enlace privado que recibas.</span>
          </div>
          <small className="auth-foot">Las cuentas, el plan y el uso quedan asociados a tu ID único de Discord.</small>
        </section>
      </div>
      <div className="auth-bottom"><span>SYNEX OBFUSCADOR</span><span>ACCESO EXCLUSIVO POR DISCORD · FREE / PREMIUM / PLUS</span></div>
    </main>
  );
}
