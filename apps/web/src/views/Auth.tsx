import React, { useState } from 'react';
import { api, ApiError, TOKEN_KEY } from '../api';

export interface SessionUser { id: string; email: string; role: string }

export function AuthView({ onAuth }: { onAuth: (token: string, user: SessionUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: any) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') await api('POST', '/api/auth/register', { email, password });
      const r = await api<{ token: string; user: SessionUser }>('POST', '/api/auth/login', { email, password });
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch { /* sin almacenamiento: sesión solo en memoria */ }
      onAuth(r.token, r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'no se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">SYNEX</div>
        <h1>{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h1>
        <label>Correo<input type="email" required value={email} onChange={(e: any) => setEmail(e.target.value)} /></label>
        <label>Contraseña<input type="password" required minLength={10} value={password} onChange={(e: any) => setPassword(e.target.value)} /></label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Procesando…' : mode === 'login' ? 'Entrar' : 'Registrarme'}</button>
        <button type="button" className="btn ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '¿No tienes cuenta? Regístrate' : 'Ya tengo cuenta'}
        </button>
      </form>
    </div>
  );
}
