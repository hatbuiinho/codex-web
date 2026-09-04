import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => { changes: number };
  };
};

const Database = require("better-sqlite3") as new (
  filename: string,
) => SqliteDatabase;

export type AppRole = "member" | "account_admin";

export type AuthSession = {
  id: string;
  userId: string;
  email: string;
  role: AppRole;
  csrfToken: string;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: AppRole;
  disabled_at: string | null;
};

type SessionRow = UserRow & {
  session_id: string;
  csrf_token: string;
};

export type AppUser = Pick<UserRow, "id" | "email" | "role"> & {
  disabled: boolean;
  createdAt: string;
};

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(password, salt, 64).toString("base64url");
  return `${salt}:${derived}`;
}

function passwordMatches(password: string, encoded: string): boolean {
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected) {
    return false;
  }
  const actual = scryptSync(password, salt, 64).toString("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name && value.length > 0) {
      cookies.set(name, decodeURIComponent(value.join("=")));
    }
  }
  return cookies;
}

export class AuthService {
  private readonly db: SqliteDatabase;
  private readonly sessionSecret: string;
  readonly cookieSecure: boolean;

  constructor() {
    this.sessionSecret = env("CODEX_WEB_AUTH_SECRET");
    if (this.sessionSecret.length < 32) {
      throw new Error("CODEX_WEB_AUTH_SECRET must be at least 32 characters");
    }

    this.cookieSecure = process.env.CODEX_WEB_AUTH_COOKIE_SECURE !== "false";
    const databasePath =
      process.env.CODEX_WEB_AUTH_DB ?? "/var/lib/codex-web/auth.db";
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('member', 'account_admin')),
        created_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        event TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.bootstrapAdmin();
  }

  private bootstrapAdmin(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
      count: number;
    };
    if (count.count > 0) {
      return;
    }
    const email = env("CODEX_WEB_BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
    const password = env("CODEX_WEB_BOOTSTRAP_ADMIN_PASSWORD");
    this.validatePassword(password);
    this.insertUser(email, password, "account_admin");
  }

  private tokenHash(token: string): string {
    return createHash("sha256")
      .update(this.sessionSecret)
      .update(token)
      .digest("base64url");
  }

  private validatePassword(password: string): void {
    if (password.length < 12) {
      throw new Error("Passwords must contain at least 12 characters");
    }
  }

  private validateEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("A valid email address is required");
    }
    return normalized;
  }

  private insertUser(email: string, password: string, role: AppRole): AppUser {
    const user: AppUser = {
      id: randomUUID(),
      email,
      role,
      disabled: false,
      createdAt: now(),
    };
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(user.id, user.email, passwordHash(password), user.role, user.createdAt);
    return user;
  }

  createUser(email: string, password: string, role: AppRole): AppUser {
    this.validatePassword(password);
    return this.insertUser(this.validateEmail(email), password, role);
  }

  listUsers(): AppUser[] {
    return this.db
      .prepare(
        "SELECT id, email, role, created_at, disabled_at FROM users ORDER BY created_at ASC",
      )
      .all()
      .map((row) => {
        const user = row as UserRow & { created_at: string };
        return {
          id: user.id,
          email: user.email,
          role: user.role,
          disabled: user.disabled_at !== null,
          createdAt: user.created_at,
        };
      });
  }

  login(email: string, password: string): { token: string; session: AuthSession } | null {
    const user = this.db
      .prepare(
        "SELECT id, email, password_hash, role, disabled_at FROM users WHERE email = ?",
      )
      .get(email.trim().toLowerCase()) as UserRow | undefined;
    if (!user || user.disabled_at || !passwordMatches(password, user.password_hash)) {
      return null;
    }

    const token = randomToken();
    const session: AuthSession = {
      id: randomUUID(),
      userId: user.id,
      email: user.email,
      role: user.role,
      csrfToken: randomToken(),
    };
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, token_hash, csrf_token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        this.tokenHash(token),
        session.csrfToken,
        session.userId,
        expiresAt,
        now(),
      );
    this.audit(session.userId, "user.login");
    return { token, session };
  }

  authenticate(cookieHeader: string | undefined): AuthSession | null {
    const token = parseCookies(cookieHeader).get("codex_web_session");
    if (!token) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT sessions.id AS session_id, sessions.csrf_token, users.id, users.email,
                users.password_hash, users.role, users.disabled_at
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(this.tokenHash(token), now()) as SessionRow | undefined;
    if (!row || row.disabled_at) {
      return null;
    }
    return {
      id: row.session_id,
      userId: row.id,
      email: row.email,
      role: row.role,
      csrfToken: row.csrf_token,
    };
  }

  logout(cookieHeader: string | undefined): void {
    const token = parseCookies(cookieHeader).get("codex_web_session");
    if (token) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(this.tokenHash(token));
    }
  }

  audit(userId: string | null, event: string, details?: string): void {
    this.db
      .prepare(
        "INSERT INTO audit_logs (id, user_id, event, details, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), userId, event, details ?? null, now());
  }

  cookie(token: string): string {
    const secure = this.cookieSecure ? "; Secure" : "";
    return `codex_web_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`;
  }

  clearCookie(): string {
    const secure = this.cookieSecure ? "; Secure" : "";
    return `codex_web_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
}
