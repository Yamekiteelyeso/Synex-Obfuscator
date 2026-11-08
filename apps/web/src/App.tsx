import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, TOKEN_KEY } from './api';
import { AuthView, SessionUser } from './views/Auth';
import { Editor, ProfileInfo, TechniqueInfo } from './views/Editor';
import { Admin, AdminData } from './views/Admin';
import { Plans } from './views/Plans';

type View = 'editor' | 'plans' | 'admin';
const NAV: { id: View; label: string; adminOnly?: boolean }[] = [
  { id: 'editor', label: 'Ofuscador' },
  { id: 'plans', label: 'Planes' },
  { id: 'admin', label: 'Administración', adminOnly: true },
];

function hasDiscordTicket(): boolean {
  return new URLSearchParams(window.location.search).has('discord_ticket');
}

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function discordErrorMessage(reason: string): string {
  if (reason === 'cancelled') return 'Cancelaste la autorización en Discord. Puedes volver a intentarlo cuando quieras.';
  if (reason === 'expired') return 'La autorización caducó o no coincide con esta sesión. Inicia el proceso de nuevo.';
  return 'Discord no pudo validar el acceso. Comprueba la configuración OAuth2 y vuelve a intentarlo.';
}

export function App() {
  // Durante el retorno OAuth no validar un token antiguo: esa petición podría
  // responder 401 después del intercambio y borrar la sesión recién creada.
  const [token, setToken] = useState<string | null>(() => hasDiscordTicket() ? null : readToken());
  const [user, setUser] = useState<SessionUser | null>(null);
  const [view, setView] = useState<View>('editor');
  const [health, setHealth] = useState<any>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [techniques, setTechniques] = useState<TechniqueInfo[]>([]);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(() => {
    const reason = new URLSearchParams(window.location.search).get('discord_error');
    return reason ? discordErrorMessage(reason) : null;
  });
  const ticketExchangeStarted = useRef(false);
  const [discordPending, setDiscordPending] = useState(hasDiscordTicket);

  const logout = useCallback(() => {
    if (token) api('POST', '/api/auth/logout', undefined, token).catch(() => undefined);
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignorar */ }
    setToken(null);
    setUser(null);
    setAdmin(null);
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const me = await api<{ user: SessionUser }>('GET', '/api/me', undefined, token);
      setUser(me.user);
      if (me.user.role === 'admin') {
        const [u, j, e, s] = await Promise.all([
          api<any>('GET', '/api/admin/users', undefined, token),
          api<any>('GET', '/api/admin/jobs', undefined, token),
          api<any>('GET', '/api/admin/errors', undefined, token),
          api<any>('GET', '/api/admin/settings', undefined, token),
        ]);
        setAdmin({ users: u.users, jobs: j.jobs, errors: e.errors, settings: s.settings });
      } else {
        setAdmin(null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) logout();
    }
  }, [token, logout]);

  useEffect(() => {
    const ticket = new URLSearchParams(window.location.search).get('discord_ticket');
    if (!ticket || ticketExchangeStarted.current) return;

    // El ticket es de un solo uso: evita consumirlo dos veces si React vuelve
    // a ejecutar el efecto durante el montaje.
    ticketExchangeStarted.current = true;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('discord_ticket');
    window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);

    api<{ token: string; user: SessionUser }>('POST', '/api/auth/discord/exchange', { ticket }).then((r) => {
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch { /* sesión en memoria */ }
      setAuthError(null);
      setToken(r.token);
      setUser(r.user);
    }).catch((error) => {
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignorar */ }
      setToken(null);
      setUser(null);
      setAuthError(error instanceof ApiError
        ? `No se pudo terminar el acceso con Discord: ${error.message}`
        : 'No se pudo terminar el acceso con Discord. Vuelve a intentarlo.');
    }).finally(() => setDiscordPending(false));
  }, []);

  useEffect(() => {
    api('GET', '/api/profiles').then((r: any) => {
      setProfiles(r.profiles);
      setTechniques(r.techniques);
    }).catch(() => undefined);
    const poll = () => api('GET', '/api/health').then(setHealth).catch(() => setHealth(null));
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (discordPending) return <div className="auth-screen"><div className="auth-card"><div className="brand-mark">SYNEX</div><p>Conectando tu cuenta de Discord…</p></div></div>;
  if (!token) return <AuthView error={authError} onAuth={(t, u) => { setToken(t); setUser(u); setAuthError(null); }} />;

  const visible = NAV.filter((item) => !item.adminOnly || user?.role === 'admin');
  const remainingUses = user?.obfuscationLimit === null || user?.obfuscationLimit === undefined
    ? null
    : Math.max(0, user.obfuscationLimit - user.obfuscationsUsed);

  async function toggleProfile(profile: string, enabled: boolean) {
    if (!token || !admin) return;
    const enabledProfiles = enabled
      ? [...admin.settings.enabledProfiles, profile]
      : admin.settings.enabledProfiles.filter((entry) => entry !== profile);
    const result = await api<any>('PUT', '/api/admin/settings', { enabledProfiles }, token);
    setAdmin({ ...admin, settings: result.settings });
  }

  async function setUserPlan(userId: string, plan: 'free' | 'premium' | 'plus') {
    if (!token) return;
    try {
      await api('PUT', `/api/admin/users/${encodeURIComponent(userId)}/plan`, { plan }, token);
      await refresh();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'No se pudo actualizar el plan');
    }
  }

  return (
    <div className="app">
      <aside id="synex-sidebar" className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand"><b className="brand-symbol small">S</b> SYNEX<span>OBFUSCADOR</span></div>
        <nav>
          {visible.map((item) => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setMenuOpen(false); }}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <small>{user?.discordUsername ? '@' + user.discordUsername : 'Cuenta de Discord'}</small>
          <small className="account-plan-label">{user?.plan.toUpperCase()} · {remainingUses === null ? 'ILIMITADO' : `${remainingUses} USOS RESTANTES`}</small>
          <button className="btn ghost" onClick={logout}>Cerrar sesión</button>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-backdrop" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} />}
      <main className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" aria-label="Menú" aria-controls="synex-sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
          <span className="muted">{health ? 'Motor en línea' : 'Motor sin conexión'}</span>
        </header>
        {view === 'editor' && (
          <Editor
            token={token}
            profiles={profiles.filter((profile) => user?.allowedProfiles?.includes(profile.name) ?? false)}
            techniques={techniques}
            maxBytes={health?.maxInputBytes}
            remainingUses={remainingUses}
            onDone={() => { void refresh(); }}
          />
        )}
        {view === 'plans' && user && <Plans token={token} user={user} onRefresh={refresh} />}
        {view === 'admin' && user?.role === 'admin' && (
          <Admin data={admin} onToggleProfile={toggleProfile} onSetUserPlan={setUserPlan} />
        )}
      </main>
    </div>
  );
}
