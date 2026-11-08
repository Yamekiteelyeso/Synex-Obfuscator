import React, { useCallback, useEffect, useState } from 'react';
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

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [view, setView] = useState<View>('editor');
  const [health, setHealth] = useState<any>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [techniques, setTechniques] = useState<TechniqueInfo[]>([]);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [discordPending, setDiscordPending] = useState(() => new URLSearchParams(window.location.search).has('discord_ticket'));

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
        const [u, j, e, s, requests] = await Promise.all([
          api<any>('GET', '/api/admin/users', undefined, token),
          api<any>('GET', '/api/admin/jobs', undefined, token),
          api<any>('GET', '/api/admin/errors', undefined, token),
          api<any>('GET', '/api/admin/settings', undefined, token),
          api<any>('GET', '/api/admin/plan-requests', undefined, token),
        ]);
        setAdmin({ users: u.users, jobs: j.jobs, errors: e.errors, settings: s.settings, planRequests: requests.requests });
      } else {
        setAdmin(null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) logout();
    }
  }, [token, logout]);

  useEffect(() => {
    const ticket = new URLSearchParams(window.location.search).get('discord_ticket');
    if (!ticket) return;
    window.history.replaceState({}, document.title, window.location.pathname);
    api<{ token: string; user: SessionUser }>('POST', '/api/auth/discord/exchange', { ticket }).then((r) => {
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch { /* sesión en memoria */ }
      setToken(r.token); setUser(r.user);
    }).catch(() => { setToken(null); setUser(null); }).finally(() => setDiscordPending(false));
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
  if (!token) return <AuthView onAuth={(t, u) => { setToken(t); setUser(u); }} />;

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

  async function updatePlanRequest(id: string, status: 'approved' | 'rejected') {
    if (!token) return;
    try {
      await api('PUT', `/api/admin/plan-requests/${id}`, { status }, token);
      await refresh();
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'No se pudo actualizar la solicitud');
    }
  }

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
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
      <main className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" aria-label="Menú" onClick={() => setMenuOpen(!menuOpen)}>☰</button>
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
          <Admin data={admin} onToggleProfile={toggleProfile} onUpdateRequest={updatePlanRequest} />
        )}
      </main>
    </div>
  );
}
