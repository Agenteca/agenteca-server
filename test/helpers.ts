import { git } from '@agenteca/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createApp,
  createUser,
  type Db,
  issueToken,
  openDb,
  type Role,
  type ServerExtensions,
} from '../src/index.js';

const created: string[] = [];
export async function tmpDir(prefix = 'agenteca-server-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
export async function cleanupTmp(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

const IDENT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
export async function commit(dir: string, files: Record<string, string>, tag?: string): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await git(['add', '-A'], { cwd: dir });
  await git([...IDENT, 'commit', '-q', '--allow-empty', '-m', tag ?? 'commit'], { cwd: dir });
  if (tag) await git(['tag', tag], { cwd: dir });
}
export async function gitRepo(files: Record<string, string>, tag?: string): Promise<string> {
  const dir = await tmpDir('agenteca-server-repo-');
  await git(['init', '-q', '-b', 'main'], { cwd: dir });
  await commit(dir, files, tag);
  return dir;
}

export function demoPackage(version: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'apm.yml': `name: demo-pack\nversion: ${version}\ndescription: Relecture de code assistée\nlicense: Apache-2.0\ntargets: [claude, cursor]\n`,
    '.apm/skills/review/SKILL.md': `---\nname: review\ndescription: Relit une modification (v${version}).\n---\n\nRelis avec soin.\n`,
    '.apm/agents/reviewer.agent.md': '---\ndescription: Relit le code.\n---\n\nTu relis.\n',
    ...extra,
  };
}

export interface Harness {
  db: Db;
  tokens: Record<Role, string>;
  userIds: Record<Role, number>;
  call(
    method: string,
    url: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<{ status: number; body: any }>;
}

/** Serveur en mémoire avec un compte par rôle et le catalogue « default ». */
export async function harness(
  mirrors: Record<string, string> = {},
  extensions?: ServerExtensions,
): Promise<Harness> {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO catalogs (slug, name, description, visibility, created_at) VALUES ('default', 'Catalogue', 'Catalogue par défaut', 'public', ?)",
  ).run(new Date().toISOString());
  const tokens = {} as Record<Role, string>;
  const userIds = {} as Record<Role, number>;
  for (const role of ['admin', 'editor', 'reader'] as Role[]) {
    const user = createUser(db, `${role}@example.test`, `mot-de-passe-${role}`, role);
    userIds[role] = user.id;
    tokens[role] = issueToken(db, user.id, 'api', 'test').token;
  }
  const cache = await tmpDir('agenteca-server-cache-');
  const app = createApp({
    db,
    indexer: {
      env: {
        PATH: process.env.PATH,
        AHUB_CACHE_DIR: cache,
        AHUB_HOME: cache,
        AHUB_GIT_MIRRORS: JSON.stringify(mirrors),
      },
    },
    ...(extensions
      ? { extensions }
      : {
          extensions: {
            ...(await import('../src/index.js')).defaultExtensions(),
            auditSink: { record: () => undefined },
          },
        }),
  });
  const call: Harness['call'] = async (method, url, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // réponse non JSON
    }
    return { status: res.status, body };
  };
  return { db, tokens, userIds, call };
}
