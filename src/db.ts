import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','editor','reader')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session','api')),
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE catalogs (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE catalog_members (
    catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','editor','reader')),
    PRIMARY KEY (catalog_id, user_id)
  );
  CREATE TABLE packages (
    id INTEGER PRIMARY KEY,
    catalog_id INTEGER NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT,
    license TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    native_plugin INTEGER NOT NULL DEFAULT 0,
    latest_version TEXT,
    latest_ref TEXT,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','pending')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (catalog_id, name)
  );
  CREATE TABLE package_versions (
    id INTEGER PRIMARY KEY,
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    ref TEXT NOT NULL,
    commit_sha TEXT,
    tree_sha256 TEXT,
    summary TEXT NOT NULL,
    scan_blocked INTEGER NOT NULL DEFAULT 0,
    findings TEXT NOT NULL DEFAULT '[]',
    indexed_at TEXT NOT NULL,
    UNIQUE (package_id, ref)
  );
  CREATE TABLE package_files (
    id INTEGER PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES package_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content TEXT,
    UNIQUE (version_id, path)
  );
  CREATE INDEX idx_packages_catalog ON packages(catalog_id);
  CREATE INDEX idx_versions_package ON package_versions(package_id);
  `,
];

/** Ouvre la base (fichier ou `:memory:`) et applique les migrations manquantes. */
export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as {
    v: number;
  };
  for (let i = row.v; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        i + 1,
        new Date().toISOString(),
      );
    })();
  }
  return db;
}

export interface CatalogRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  created_at: string;
}

export interface PackageRow {
  id: number;
  catalog_id: number;
  name: string;
  source: string;
  description: string | null;
  license: string | null;
  tools: string;
  tags: string;
  native_plugin: number;
  latest_version: string | null;
  latest_ref: string | null;
  status: 'published' | 'pending';
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  package_id: number;
  version: string;
  ref: string;
  commit_sha: string | null;
  tree_sha256: string | null;
  summary: string;
  scan_blocked: number;
  findings: string;
  indexed_at: string;
}

export interface FileRow {
  id: number;
  version_id: number;
  path: string;
  size: number;
  sha256: string;
  content: string | null;
}

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: 'admin' | 'editor' | 'reader';
  created_at: string;
}
