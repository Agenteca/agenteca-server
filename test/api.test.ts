import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildOpenApiDocument,
  defaultAccessPolicy,
  defaultExtensions,
  openDb,
  type AuditEvent,
} from '../src/index.js';
import { cleanupTmp, commit, demoPackage, gitRepo, harness } from './helpers.js';

afterAll(cleanupTmp);
const SOURCE = 'acme/demo-pack';
const ID = 'github.com/acme/demo-pack';

describe('catalogue', () => {
  it('indexes a repository, makes it searchable and shows its content before installation', async () => {
    const repo = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    await commit(repo, demoPackage('1.1.0'), 'v1.1.0');
    const h = await harness({ [ID]: repo });

    const created = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: SOURCE, tags: ['relecture', 'qualité'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.versions).toEqual(['1.1.0', '1.0.0']);
    expect(created.body.package).toMatchObject({
      catalog: 'default',
      name: 'demo-pack',
      source: 'acme/demo-pack#v1.1.0',
      repository: 'acme/demo-pack',
      description: 'Relecture de code assistée',
      license: 'Apache-2.0',
      tools: ['claude', 'cursor'],
      tags: ['relecture', 'qualité'],
      nativePlugin: false,
      latestVersion: '1.1.0',
      status: 'published',
      installCommand: 'ahub add acme/demo-pack#v1.1.0',
    });
    const id = created.body.package.id;

    // Public search, without authentication.
    const all = await h.call('GET', '/api/v1/packages');
    expect(all.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect((await h.call('GET', '/api/v1/packages?q=relecture+code')).body.total).toBe(1);
    expect((await h.call('GET', '/api/v1/packages?q=QUALITÉ')).body.total).toBe(1);
    expect((await h.call('GET', '/api/v1/packages?q=absent')).body.total).toBe(0);
    expect((await h.call('GET', '/api/v1/packages?tool=cursor')).body.total).toBe(1);
    expect((await h.call('GET', '/api/v1/packages?tool=codex')).body.total).toBe(0);
    expect((await h.call('GET', '/api/v1/packages?tool=emacs')).status).toBe(400);

    const versions = await h.call('GET', `/api/v1/packages/${id}/versions`);
    expect(versions.body.items.map((v: any) => [v.version, v.ref, v.scanBlocked])).toEqual([
      ['1.1.0', 'v1.1.0', false],
      ['1.0.0', 'v1.0.0', false],
    ]);
    expect(versions.body.items[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(versions.body.items[0].treeSha256).toMatch(/^sha256:/);

    const detail = await h.call('GET', `/api/v1/packages/${id}/versions/1.1.0`);
    expect(detail.body.contents).toMatchObject({ agents: ['reviewer'], skills: [{ name: 'review' }] });
    expect(detail.body.files.map((f: any) => f.path)).toEqual([
      '.apm/agents/reviewer.agent.md',
      '.apm/skills/review/SKILL.md',
      'apm.yml',
    ]);
    const file = await h.call(
      'GET',
      `/api/v1/packages/${id}/versions/1.1.0/file?path=${encodeURIComponent('.apm/skills/review/SKILL.md')}`,
    );
    expect(file.body.content).toContain('Relit une modification (v1.1.0)');
    expect(
      (await h.call('GET', `/api/v1/packages/${id}/versions/v1.0.0/file?path=apm.yml`)).body.content,
    ).toContain('version: 1.0.0');
    expect((await h.call('GET', `/api/v1/packages/${id}/versions/9.9.9`)).status).toBe(404);
    expect((await h.call('GET', `/api/v1/packages/${id}/versions/1.1.0/file?path=absent`)).status).toBe(404);

    // Refresh after a new tag.
    await commit(repo, demoPackage('1.2.0'), 'v1.2.0');
    const refreshed = await h.call('POST', `/api/v1/packages/${id}/refresh`, { token: h.tokens.editor });
    expect(refreshed.body.package.latestVersion).toBe('1.2.0');
    expect((await h.call('GET', `/api/v1/packages/${id}/versions`)).body.items).toHaveLength(3);
  });

  it('reports a version whose scan is blocking', async () => {
    const hidden = [...'evil'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    const repo = await gitRepo(
      demoPackage('1.0.0', {
        '.apm/agents/reviewer.agent.md': `---\ndescription: Piégé.\n---\nTexte${hidden}\n`,
      }),
      'v1.0.0',
    );
    const h = await harness({ [ID]: repo });
    const created = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: SOURCE },
    });
    const detail = await h.call('GET', `/api/v1/packages/${created.body.package.id}/versions/1.0.0`);
    expect(detail.body.scanBlocked).toBe(true);
    expect(detail.body.findings[0]).toMatchObject({ ruleId: 'AHUB-U001', severity: 'critical' });
  });

  it('indexes the default branch when the repository has no tag', async () => {
    const repo = await gitRepo({ 'SKILL.md': '---\nname: solo\ndescription: Un skill seul.\n---\nCorps\n' });
    const h = await harness({ 'github.com/acme/solo': repo });
    const created = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: 'acme/solo' },
    });
    expect(created.body.package).toMatchObject({
      name: 'solo',
      latestVersion: 'main',
      source: 'acme/solo',
      tools: ['claude', 'codex', 'copilot', 'cursor'],
    });
  });

  it('refuses invalid or unreadable sources', async () => {
    const empty = await gitRepo({ 'README.md': 'rien' });
    const h = await harness({ 'github.com/acme/vide': empty });
    const local = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: './chemin/local' },
    });
    expect([local.status, local.body.error.code]).toEqual([422, 'SOURCE_INVALID']);
    const invalid = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: 'acme/vide' },
    });
    expect([invalid.status, invalid.body.error.code]).toEqual([422, 'PACKAGE_INVALID']);
    expect((await h.call('POST', '/api/v1/packages', { token: h.tokens.editor, body: {} })).status).toBe(400);
    expect((await h.call('GET', '/api/v1/packages')).body.total).toBe(0);
  });

  it('exports the catalog to the native marketplace formats', async () => {
    const plugin = await gitRepo(
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'my-plugin',
          version: '1.0.0',
          description: 'Un plugin',
        }),
        'skills/s/SKILL.md': '---\nname: s\ndescription: S.\n---\n',
      },
      'v1.0.0',
    );
    const apm = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    const h = await harness({ 'github.com/acme/my-plugin': plugin, [ID]: apm });
    await h.call('POST', '/api/v1/packages', { token: h.tokens.editor, body: { source: 'acme/my-plugin' } });
    await h.call('POST', '/api/v1/packages', { token: h.tokens.editor, body: { source: SOURCE } });

    const claude = await h.call('GET', '/api/v1/catalogs/default/export/claude');
    expect(claude.body.path).toBe('.claude-plugin/marketplace.json');
    expect(claude.body.marketplace).toMatchObject({ name: 'default', owner: { name: 'Catalogue' } });
    expect(claude.body.marketplace.plugins).toEqual([
      {
        name: 'my-plugin',
        description: 'Un plugin',
        version: '1.0.0',
        source: { source: 'github', repo: 'acme/my-plugin', ref: 'v1.0.0' },
      },
    ]);
    expect(claude.body.skipped).toHaveLength(1);

    const codex = await h.call('GET', '/api/v1/catalogs/default/export/codex?all=true');
    expect(codex.body.path).toBe('.agents/plugins/marketplace.json');
    expect(codex.body.marketplace.plugins.map((p: any) => p.name)).toEqual(['demo-pack', 'my-plugin']);
    expect((await h.call('GET', '/api/v1/catalogs/default/export/copilot')).body.path).toBe(
      '.github/plugin/marketplace.json',
    );
    expect((await h.call('GET', '/api/v1/catalogs/default/export/emacs')).status).toBe(400);
  });
});

describe('accounts and roles', () => {
  it('opens and closes a session, without revealing whether an account exists', async () => {
    const h = await harness();
    const wrong = await h.call('POST', '/api/v1/auth/login', {
      body: { email: 'admin@example.test', password: 'faux' },
    });
    const unknown = await h.call('POST', '/api/v1/auth/login', {
      body: { email: 'personne@example.test', password: 'faux' },
    });
    expect([wrong.status, wrong.body.error.message]).toEqual([unknown.status, unknown.body.error.message]);
    expect(wrong.status).toBe(401);

    const login = await h.call('POST', '/api/v1/auth/login', {
      body: { email: 'ADMIN@example.test', password: 'mot-de-passe-admin' },
    });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: 'admin@example.test', role: 'admin' });
    expect(new Date(login.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await h.call('GET', '/api/v1/me', { token: login.body.token })).body.role).toBe('admin');
    // Tokens and passwords are never stored in clear.
    const stored =
      JSON.stringify(h.db.prepare('SELECT * FROM tokens').all()) +
      JSON.stringify(h.db.prepare('SELECT * FROM users').all());
    expect(stored).not.toContain(login.body.token);
    expect(stored).not.toContain('mot-de-passe-admin');

    expect((await h.call('POST', '/api/v1/auth/logout', { token: login.body.token })).status).toBe(200);
    expect((await h.call('GET', '/api/v1/me', { token: login.body.token })).status).toBe(401);
    expect((await h.call('GET', '/api/v1/me')).status).toBe(401);
    expect((await h.call('GET', '/api/v1/me', { token: 'ags_inconnu' })).body.error.code).toBe(
      'TOKEN_INVALID',
    );
  });

  it('refuses an expired session token', async () => {
    const h = await harness();
    const login = await h.call('POST', '/api/v1/auth/login', {
      body: { email: 'reader@example.test', password: 'mot-de-passe-reader' },
    });
    h.db.prepare("UPDATE tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'session'").run();
    expect((await h.call('GET', '/api/v1/me', { token: login.body.token })).status).toBe(401);
  });

  it('creates and revokes API tokens', async () => {
    const h = await harness();
    const created = await h.call('POST', '/api/v1/tokens', { token: h.tokens.editor, body: { name: 'ci' } });
    expect(created.status).toBe(201);
    expect((await h.call('GET', '/api/v1/me', { token: created.body.token })).body.role).toBe('editor');
    expect((await h.call('GET', '/api/v1/tokens', { token: h.tokens.editor })).body.items).toHaveLength(2);
    // A user only revokes their own tokens.
    expect(
      (await h.call('DELETE', `/api/v1/tokens/${created.body.id}`, { token: h.tokens.reader })).status,
    ).toBe(404);
    expect(
      (await h.call('DELETE', `/api/v1/tokens/${created.body.id}`, { token: h.tokens.editor })).status,
    ).toBe(200);
    expect((await h.call('GET', '/api/v1/me', { token: created.body.token })).status).toBe(401);
  });

  it('applies the three base roles', async () => {
    const repo = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    const h = await harness({ [ID]: repo });
    const body = { source: SOURCE };
    expect((await h.call('POST', '/api/v1/packages', { body })).status).toBe(401);
    expect((await h.call('POST', '/api/v1/packages', { token: h.tokens.reader, body })).status).toBe(403);
    const created = await h.call('POST', '/api/v1/packages', { token: h.tokens.editor, body });
    expect(created.status).toBe(201);
    const id = created.body.package.id;
    expect((await h.call('DELETE', `/api/v1/packages/${id}`, { token: h.tokens.editor })).status).toBe(403);
    expect(
      (await h.call('POST', '/api/v1/catalogs', { token: h.tokens.editor, body: { slug: 'x', name: 'X' } }))
        .status,
    ).toBe(403);
    expect((await h.call('GET', '/api/v1/users', { token: h.tokens.editor })).status).toBe(403);
    expect((await h.call('GET', '/api/v1/users', { token: h.tokens.admin })).body.items).toHaveLength(3);
    expect(
      (
        await h.call('POST', '/api/v1/users', {
          token: h.tokens.admin,
          body: { email: 'nouveau@example.test', password: 'court', role: 'reader' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call('POST', '/api/v1/users', {
          token: h.tokens.admin,
          body: { email: 'nouveau@example.test', password: 'un-mot-de-passe-long', role: 'reader' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await h.call('POST', '/api/v1/users', {
          token: h.tokens.admin,
          body: { email: 'nouveau@example.test', password: 'un-mot-de-passe-long', role: 'reader' },
        })
      ).status,
    ).toBe(409);
    expect((await h.call('DELETE', `/api/v1/packages/${id}`, { token: h.tokens.admin })).status).toBe(200);
    expect((await h.call('GET', `/api/v1/packages/${id}`)).status).toBe(404);
  });

  it('entirely hides a private catalog from non-members', async () => {
    const repo = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    const h = await harness({ [ID]: repo });
    expect(
      (
        await h.call('POST', '/api/v1/catalogs', {
          token: h.tokens.admin,
          body: { slug: 'interne', name: 'Interne', visibility: 'private' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await h.call('POST', '/api/v1/catalogs', {
          token: h.tokens.admin,
          body: { slug: 'interne', name: 'Interne' },
        })
      ).status,
    ).toBe(409);
    const created = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.admin,
      body: { source: SOURCE, catalog: 'interne' },
    });
    const id = created.body.package.id;

    // Anonymous user and non-member global editor: the catalog does not exist for them.
    for (const token of [undefined, h.tokens.editor, h.tokens.reader]) {
      const opts = token ? { token } : {};
      expect((await h.call('GET', '/api/v1/catalogs', opts)).body.items.map((c: any) => c.slug)).toEqual([
        'default',
      ]);
      expect((await h.call('GET', '/api/v1/catalogs/interne', opts)).status).toBe(404);
      expect((await h.call('GET', '/api/v1/packages', opts)).body.total).toBe(0);
      expect((await h.call('GET', `/api/v1/packages/${id}`, opts)).status).toBe(404);
      expect(
        (await h.call('GET', `/api/v1/packages/${id}/versions/1.0.0/file?path=apm.yml`, opts)).status,
      ).toBe(404);
      expect((await h.call('GET', '/api/v1/catalogs/interne/export/claude', opts)).status).toBe(404);
    }
    expect(
      (
        await h.call('POST', '/api/v1/packages', {
          token: h.tokens.editor,
          body: { source: SOURCE, catalog: 'interne' },
        })
      ).status,
    ).toBe(404);

    // The reader becomes an editor member of this catalog only.
    expect(
      (
        await h.call('PUT', `/api/v1/catalogs/interne/members/${h.userIds.reader}`, {
          token: h.tokens.editor,
          body: { role: 'editor' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.call('PUT', `/api/v1/catalogs/interne/members/${h.userIds.reader}`, {
          token: h.tokens.admin,
          body: { role: 'editor' },
        })
      ).status,
    ).toBe(200);
    expect((await h.call('GET', '/api/v1/packages', { token: h.tokens.reader })).body.total).toBe(1);
    expect((await h.call('POST', `/api/v1/packages/${id}/refresh`, { token: h.tokens.reader })).status).toBe(
      200,
    );
    expect(
      (await h.call('POST', '/api/v1/packages', { token: h.tokens.reader, body: { source: SOURCE } })).status,
    ).toBe(403);
    expect(
      (
        await h.call('DELETE', `/api/v1/catalogs/interne/members/${h.userIds.reader}`, {
          token: h.tokens.admin,
        })
      ).status,
    ).toBe(200);
    expect((await h.call('GET', '/api/v1/packages', { token: h.tokens.reader })).body.total).toBe(0);
  });

  it('decides access through the default policy', () => {
    const pub = { id: 1, slug: 'p', visibility: 'public' as const };
    const priv = { id: 2, slug: 'q', visibility: 'private' as const };
    const u = (role: 'admin' | 'editor' | 'reader') => ({ id: 1, email: 'x', role });
    expect(defaultAccessPolicy.can(null, 'package.read', pub)).toBe(true);
    expect(defaultAccessPolicy.can(null, 'package.read', priv)).toBe(false);
    expect(defaultAccessPolicy.can(u('editor'), 'package.read', priv)).toBe(false);
    expect(defaultAccessPolicy.can(u('reader'), 'package.read', priv, 'reader')).toBe(true);
    expect(defaultAccessPolicy.can(u('reader'), 'package.publish', priv, 'reader')).toBe(false);
    expect(defaultAccessPolicy.can(u('reader'), 'package.publish', pub, 'editor')).toBe(true);
    expect(defaultAccessPolicy.can(u('admin'), 'package.delete', priv)).toBe(true);
    expect(defaultAccessPolicy.can(u('editor'), 'catalog.create')).toBe(false);
  });
});

describe('premium extension points', () => {
  it('lets a module replace the access policy, the validation and the log', async () => {
    const repo = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    const events: AuditEvent[] = [];
    const h = await harness(
      { [ID]: repo },
      {
        ...defaultExtensions(),
        edition: 'test',
        auditSink: { record: (e) => void events.push(e) },
        publishGate: { review: async () => ({ decision: 'pending' }) },
      },
    );
    expect((await h.call('GET', '/healthz')).body).toEqual({
      status: 'ok',
      version: '0.1.0',
      edition: 'test',
    });
    const created = await h.call('POST', '/api/v1/packages', {
      token: h.tokens.editor,
      body: { source: SOURCE },
    });
    expect(created.body.package.status).toBe('pending');
    // Awaiting validation: invisible to the public, visible to whoever can publish.
    expect((await h.call('GET', '/api/v1/packages')).body.total).toBe(0);
    expect((await h.call('GET', `/api/v1/packages/${created.body.package.id}`)).status).toBe(404);
    expect(
      (await h.call('GET', `/api/v1/packages/${created.body.package.id}`, { token: h.tokens.editor })).status,
    ).toBe(200);
    await h.call('POST', '/api/v1/packages', { token: h.tokens.reader, body: { source: SOURCE } });
    expect(events.map((e) => [e.action, e.outcome, e.actor])).toEqual([
      ['package.publish', 'success', 'editor@example.test'],
      ['package.publish', 'denied', 'reader@example.test'],
    ]);
  });
});

describe('contrat OpenAPI', () => {
  it('serves an OpenAPI 3.1 document identical to the committed file', async () => {
    const h = await harness();
    const served = await h.call('GET', '/api/v1/openapi.json');
    expect(served.status).toBe(200);
    expect(served.body.openapi).toBe('3.1.0');
    expect(Object.keys(served.body.paths)).toContain('/api/v1/packages/{id}/versions/{version}/file');
    expect(served.body.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    const db = openDb(':memory:');
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    // If this test fails after an API change: "npm run openapi", then update the version and the CHANGELOG.
    expect(JSON.parse(JSON.stringify(buildOpenApiDocument(db)))).toEqual(committed);
  });

  it('answers unknown routes in JSON', async () => {
    const h = await harness();
    const r = await h.call('GET', '/api/v1/inconnu');
    expect([r.status, r.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });
});
