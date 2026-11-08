import React, { useState } from 'react';
import { api, ApiError, TOKEN_KEY } from '../api';

export interface SessionUser { id: string; email: string; discordUsername?: string; role: string }

export function AuthView({ onAuth }: { onAuth: (token: string, user: SessionUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: any) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      if (mode === 'register') await api('POST', '/api/auth/register', { email, password });
      const r = await api<{ token: string; user: SessionUser }>('POST', '/api/auth/login', { email, password });
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch { /* sesión en memoria */ }
      onAuth(r.token, r.user);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor'); }
    finally { setBusy(false); }
  }

  return (
    <main className="auth-screen">
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="brand-mark"><span className="brand-symbol">S</span> SYNEX</div>
          <p className="eyebrow">LUA / LUAU CODE PROTECTION</p>
          <h1>Tu código.<br /><span>Fuera de la vista.</span></h1>
          <p className="auth-lead">Ofuscación de scripts con transformaciones por niveles y una VM diseñada para Luau.</p>
          <div className="plan-preview">
            <article><span>01 / BASIC</span><strong>Esencial</strong><small>Renombrado y protección de cadenas.</small></article>
            <article><span>02 / MEDIUM</span><strong>Reforzado</strong><small>Más transformaciones y flujo de control.</small></article>
            <article><span>03 / MAX</span><strong>Máximo</strong><small>VM y técnicas avanzadas combinadas.</small></article>
          </div>
        </section>
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-top"><span className="eyebrow">SYNEX OBFUSCADOR</span><span className="status-dot">● SISTEMA EN LÍNEA</span></div>
          <h2>{mode === 'login' ? 'Bienvenido de vuelta' : 'Crea tu cuenta'}</h2>
          <p className="muted">{mode === 'login' ? 'Accede a tu espacio de ofuscación.' : 'Regístrate para comenzar a proteger tus scripts.'}</p>
          <label>Correo electrónico<input type="email" autoComplete="email" required value={email} onChange={(e: any) => setEmail(e.target.value)} /></label>
          <label>Contraseña<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} value={password} onChange={(e: any) => setPassword(e.target.value)} /></label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn primary auth-submit" disabled={busy}>{busy ? 'Procesando…' : mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'} <span>↗</span></button>
          <div className="auth-divider"><span>o continúa con</span></div>
          <a className="btn discord-btn" href="/api/auth/discord"><span className="discord-glyph">◈</span> Discord</a>
          <button type="button" className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
            {mode === 'login' ? '¿No tienes cuenta? Crear una' : '¿Ya tienes cuenta? Inicia sesión'}
          </button>
          <small className="auth-foot">Usa Synex de forma responsable y respeta los derechos de terceros.</small>
        </form>
      </div>
    </main>
  );
}