import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { User } from './auth.js';

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

export interface Settings {
  maxInputBytes: number;
  enabledProfiles: string[];
}

interface Data {
  users: User[];
  history: HistoryEntry[];
  errors: ErrorEntry[];
  settings: Settings;
}

const MAX_ERRORS = 200;

const DEFAULT_SETTINGS: Settings = {
  maxInputBytes: 1024 * 1024,
  enabledProfiles: ['basic', 'medium', 'max'],
};

/**
 * Almacén en un archivo JSON. Las escrituras son atómicas (archivo temporal + rename).
 * Si no se indica archivo, funciona solo en memoria (pruebas).
 */
export class Store {
  private data: Data;

  constructor(private readonly file: string | null) {
    this.data = { users: [], history: [], errors: [], settings: { ...DEFAULT_SETTINGS } };
    if (file && existsSync(file)) {
      const loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Data>;
      this.data = { ...this.data, ...loaded, settings: { ...DEFAULT_SETTINGS, ...loaded.settings, enabledProfiles: ['basic', 'medium', 'max'] } };
    }
  }

  get users(): User[] {
    return this.data.users;
  }

  get history(): HistoryEntry[] {
    return this.data.history;
  }

  get errors(): ErrorEntry[] {
    return this.data.errors;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  addUser(u: User): void {
    this.data.users.push(u);
    this.save();
  }

  updateUser(user: User): void {
    const index = this.data.users.findIndex((u) => u.id === user.id);
    if (index >= 0) { this.data.users[index] = user; this.save(); }
  }

  addHistory(h: HistoryEntry): void {
    this.data.history.push(h);
    this.save();
  }

  updateHistory(id: string, patch: Partial<HistoryEntry>): void {
    const h = this.data.history.find((x) => x.id === id);
    if (!h) return;
    Object.assign(h, patch);
    this.save();
  }

  logError(e: ErrorEntry): void {
    this.data.errors.push(e);
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
