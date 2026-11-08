import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  role: Role;
  passwordHash: string;
  discordId?: string;
  discordUsername?: string;
  createdAt: number;
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

interface Session {
  userId: string;
  expiresAt: number;
}

/** Sesiones con token opaco aleatorio y caducidad. Viven en memoria. */
export class Sessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlMs = 12 * 60 * 60 * 1000, private readonly now = () => Date.now()) {}

  create(userId: string): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { userId, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  userIdFor(token: string): string | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s.userId;
  }

  revoke(token: string): void {
    this.sessions.delete(token);
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
