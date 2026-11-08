import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'user';
export type AccountPlan = 'free' | 'premium' | 'plus';

export interface User {
  id: string;
  email: string;
  role: Role;
  passwordHash: string;
  discordId?: string;
  discordUsername?: string;
  createdAt: number;
  plan: AccountPlan;
  obfuscationsUsed: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(email: unknown, password: unknown): string | null {
  if (typeof email !== 'string' || !EMAIL.test(email) || email.length > 254) return 'correo no válido';
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return 'la contraseña debe tener entre 8 y 256 caracteres';
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: number;
}

export interface SessionPersistence {
  readSessions(): SessionRecord[];
  writeSessions(sessions: SessionRecord[]): void;
}

/** Sesiones opacas con caducidad y persistencia opcional en el almacén de cuentas. */
export class Sessions {
  private readonly sessions: Map<string, SessionRecord>;

  constructor(
    private readonly ttlMs = 12 * 60 * 60 * 1000,
    private readonly now = () => Date.now(),
    private readonly persistence?: SessionPersistence,
  ) {
    this.sessions = new Map((persistence?.readSessions() ?? []).map((entry) => [entry.token, entry]));
    this.prune();
  }

  private persist(): void {
    this.persistence?.writeSessions([...this.sessions.values()]);
  }

  private prune(): void {
    const now = this.now();
    let changed = false;
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  create(userId: string): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, userId, expiresAt: this.now() + this.ttlMs });
    this.persist();
    return token;
  }

  userIdFor(token: string): string | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      this.persist();
      return null;
    }
    return session.userId;
  }

  revoke(token: string): void {
    if (this.sessions.delete(token)) this.persist();
  }
}

/** Limita intentos de inicio de sesión fallidos por correo. */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max = 5, private readonly windowMs = 15 * 60 * 1000, private readonly now = () => Date.now()) {}

  blocked(email: string): boolean {
    const f = this.failures.get(email);
    if (!f) return false;
    if (f.resetAt < this.now()) {
      this.failures.delete(email);
      return false;
    }
    return f.count >= this.max;
  }

  fail(email: string): void {
    const f = this.failures.get(email);
    if (!f || f.resetAt < this.now()) this.failures.set(email, { count: 1, resetAt: this.now() + this.windowMs });
    else f.count++;
  }

  reset(email: string): void {
    this.failures.delete(email);
  }
}
