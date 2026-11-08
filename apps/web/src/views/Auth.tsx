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
            <article><span>01</span><strong>Basic</strong><small>Ofuscación esencial y ligera.</small><i>01 / 03</i></article>
            <article><span>02</span><strong>Medium</strong><small>Transformaciones adicionales.</small><i>02 / 03</i></article>
            <article><span>03</span><strong>Max</strong><small>VM y protección avanzada.</small><i>03 / 03</i></article>
          </div>
          <div className="auth-feature-line"><span>CADENA</span><i /><span>FLUJO DE CONTROL</span><i /><span>VM LUAU</span></div>
        </section>
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-top"><span className="eyebrow">ACCESO A SYNEX</span><span className="status-dot"><b /> MOTOR DISPONIBLE</span></div>
          <h2>{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h2>
          <p className="muted">{mode === 'login' ? 'Entra para continuar protegiendo tu código.' : 'Crea tu cuenta para empezar a ofuscar.'}</p>
          <label>Correo electrónico<input type="email" autoComplete="email" required value={email} onChange={(e: any) => setEmail(e.target.value)} /></label>
          <label>Contraseña<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} value={password} onChange={(e: any) => setPassword(e.target.value)} /></label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn primary auth-submit" disabled={busy}>{busy ? 'Procesando…' : mode === 'login' ? 'Entrar a Synex' : 'Crear cuenta'} <span>↗</span></button>
          <div className="auth-divider"><span>O CONTINÚA CON</span></div>
          <a className="btn discord-btn" href="/api/auth/discord"><span className="discord-glyph">◈</span> Discord</a>
          <small className="auth-foot">Instala el bot y ejecuta <b>/synex-login</b> para recibir un enlace privado de acceso.</small>
          <button type="button" className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
            {mode === 'login' ? '¿No tienes cuenta? Crear una' : '¿Ya tienes cuenta? Iniciar sesión'}
          </button>
        </form>
      </div>
      <div className="auth-bottom"><span>SYNEX OBFUSCADOR</span><span>LUA / LUAU · BASIC / MEDIUM / MAX</span></div>
    </main>
  );
}