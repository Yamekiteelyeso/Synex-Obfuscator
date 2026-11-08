import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AccountPlan, SessionRecord, User } from './auth.js';

export interface HistoryEntry {
  id: string;
  userId: string;
  fileName: string;
  profile: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  durationMs?: number;
  digest?: string;
  outputBytes?: number;
  equivalence?: string;
  error?: { message: string; code?: string };
}

export interface ErrorEntry {
  at: number;
  method: string;
  path: string;
  message: string;
}

export interface PlanRequest {
  id: string;
  userId: string;
  plan: Exclude<AccountPlan, 'free'>;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  maxInputBytes: number;
  enabledProfiles: string[];
}

interface Data {
  users: User[];
  history: HistoryEntry[];
  errors: ErrorEntry[];
  planRequests: PlanRequest[];
  settings: Settings;
  sessions: SessionRecord[];
}

const MAX_ERRORS = 200;

const DEFAULT_SETTINGS: Settings = {
  maxInputBytes: 1024 * 1024,
  enabledProfiles: ['basic', 'medium', 'max'],
};

/** Almacén JSON con escrituras atómicas y migración de cuentas existentes. */
export class Store {
  private data: Data;

  constructor(private readonly file: string | null) {
    this.data = { users: [], history: [], errors: [], planRequests: [], settings: { ...DEFAULT_SETTINGS }, sessions: [] };
    if (file && existsSync(file)) {
      const loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Data>;
      const history = Array.isArray(loaded.history) ? loaded.history : [];
      const users = (Array.isArray(loaded.users) ? loaded.users : []).map((raw) => {
        const plan: AccountPlan = raw.plan === 'premium' || raw.plan === 'plus' ? raw.plan : 'free';
        const migratedUsage = history.filter((entry) => entry.userId === raw.id).length;
        const obfuscationsUsed = Number.isSafeInteger(raw.obfuscationsUsed) && raw.obfuscationsUsed >= 0
          ? raw.obfuscationsUsed
          : migratedUsage;
        return { ...raw, plan, obfuscationsUsed } as User;
      });
      this.data = {
        users,
        history,
        errors: Array.isArray(loaded.errors) ? loaded.errors : [],
        planRequests: Array.isArray(loaded.planRequests) ? loaded.planRequests : [],
        settings: { ...DEFAULT_SETTINGS, ...loaded.settings, enabledProfiles: ['basic', 'medium', 'max'] },
        sessions: Array.isArray(loaded.sessions) ? loaded.sessions.filter((entry) =>
          entry && typeof entry.token === 'string' && typeof entry.userId === 'string'
          && Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now()) : [],
      };
    }
  }

  get users(): User[] { return this.data.users; }
  get history(): HistoryEntry[] { return this.data.history; }
  get errors(): ErrorEntry[] { return this.data.errors; }
  get planRequests(): PlanRequest[] { return this.data.planRequests; }
  get settings(): Settings { return this.data.settings; }

  readSessions(): SessionRecord[] { return this.data.sessions.slice(); }

  writeSessions(sessions: SessionRecord[]): void {
    this.data.sessions = sessions;
    this.save();
  }

  addUser(user: User): void {
    this.data.users.push(user);
    this.save();
  }

  updateUser(user: User): void {
    const index = this.data.users.findIndex((entry) => entry.id === user.id);
    if (index >= 0) {
      this.data.users[index] = user;
      this.save();
    }
  }

  recordObfuscation(userId: string): number {
    const user = this.data.users.find((entry) => entry.id === userId);
    if (!user) throw new Error('cuenta no encontrada al registrar el uso');
    user.obfuscationsUsed += 1;
    this.save();
    return user.obfuscationsUsed;
  }

  setUserPlan(userId: string, plan: AccountPlan): User | null {
    const user = this.data.users.find((entry) => entry.id === userId);
    if (!user) return null;
    user.plan = plan;
    this.save();
    return user;
  }

  createPlanRequest(request: PlanRequest): PlanRequest {
    const existing = this.data.planRequests.find((entry) =>
      entry.userId === request.userId && entry.plan === request.plan && entry.status === 'pending');
    if (existing) return existing;
    this.data.planRequests.push(request);
    this.save();
    return request;
  }

  updatePlanRequest(id: string, status: PlanRequest['status']): PlanRequest | null {
    const request = this.data.planRequests.find((entry) => entry.id === id);
    if (!request) return null;
    request.status = status;
    request.updatedAt = Date.now();
    this.save();
    return request;
  }

  addHistory(entry: HistoryEntry): void {
    this.data.history.push(entry);
    this.save();
  }

  updateHistory(id: string, patch: Partial<HistoryEntry>): void {
    const entry = this.data.history.find((item) => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.save();
  }

  logError(entry: ErrorEntry): void {
    this.data.errors.push(entry);
    if (this.data.errors.length > MAX_ERRORS) this.data.errors.splice(0, this.data.errors.length - MAX_ERRORS);
    this.save();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  private save(): void {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
