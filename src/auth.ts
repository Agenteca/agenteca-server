import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db, UserRow } from './db.js';
import type { Role, User } from './extensions.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Seule l'empreinte d'un jeton est stockée : une fuite de la base ne donne aucun jeton utilisable. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createUser(db: Db, email: string, password: string, role: Role): User {
  const info = db
    .prepare('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(email.trim(), hashPassword(password), role, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), email: email.trim(), role };
}

export function issueToken(
  db: Db,
  userId: number,
  kind: 'session' | 'api',
  name: string,
  now = new Date(),
): { id: number; token: string; expiresAt: string | null } {
  const token = `${kind === 'api' ? 'agk' : 'ags'}_${randomBytes(32).toString('base64url')}`;
  const expiresAt = kind === 'session' ? new Date(now.getTime() + SESSION_TTL_MS).toISOString() : null;
  const info = db
    .prepare(
      'INSERT INTO tokens (user_id, token_hash, name, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(userId, hashToken(token), name, kind, expiresAt, now.toISOString());
  return { id: Number(info.lastInsertRowid), token, expiresAt };
}

export function userFromToken(db: Db, token: string, now = new Date()): User | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.role, t.expires_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
    .get(hashToken(token)) as
    (Pick<UserRow, 'id' | 'email' | 'role'> & { expires_at: string | null }) | undefined;
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null;
  return { id: row.id, email: row.email, role: row.role };
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return m?.[1];
}

/**
 * Crée le premier administrateur si la base n'a aucun utilisateur. Sans mot de
 * passe fourni, un mot de passe aléatoire est généré et retourné une seule fois.
 */
export function bootstrapAdmin(
  db: Db,
  email: string | undefined,
  password: string | undefined,
): { email: string; generatedPassword?: string } | undefined {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return undefined;
  const adminEmail = email?.trim() || 'admin@localhost';
  if (password) {
    createUser(db, adminEmail, password, 'admin');
    return { email: adminEmail };
  }
  const generated = randomBytes(18).toString('base64url');
  createUser(db, adminEmail, generated, 'admin');
  return { email: adminEmail, generatedPassword: generated };
}
