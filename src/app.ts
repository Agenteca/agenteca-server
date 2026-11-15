import { type Catalog, exportMarketplace, type MarketplaceFormat } from '@agenteca/core';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bearerToken, createUser, hashToken, issueToken, userFromToken, verifyPassword } from './auth.js';
import type { CatalogRow, Db, FileRow, PackageRow, UserRow, VersionRow } from './db.js';
import {
  type Action,
  type CatalogRef,
  defaultExtensions,
  type Role,
  type ServerExtensions,
  type User,
} from './extensions.js';
import { IndexError, indexPackage, type IndexerOptions } from './indexer.js';

export const API_VERSION = '0.1.0';

export interface AppOptions {
  db: Db;
  extensions?: ServerExtensions;
  indexer?: IndexerOptions;
  /** Public address of the server, used in the OpenAPI documentation. */
  publicUrl?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- Schemas ---------------------------------------------------------------

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).openapi('Error');
const RoleSchema = z.enum(['admin', 'editor', 'reader']).openapi('Role');
const ToolSchema = z.enum(['claude', 'codex', 'copilot', 'cursor']).openapi('Tool');
const UserSchema = z.object({ id: z.number().int(), email: z.string(), role: RoleSchema }).openapi('User');
const CatalogSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    visibility: z.enum(['public', 'private']),
    packageCount: z.number().int(),
  })
  .openapi('Catalog');
const PackageSchema = z
  .object({
    id: z.number().int(),
    catalog: z.string(),
    name: z.string(),
    source: z.string().openapi({
      description:
        'Reference that "ahub add" can install (OpenAPM form), pinned to the latest version when it is tagged.',
    }),
    repository: z.string().openapi({ description: 'Reference of the repository, without a version.' }),
    description: z.string().nullable(),
    license: z.string().nullable().openapi({ description: 'SPDX identifier declared by the package.' }),
    tools: z.array(ToolSchema),
    tags: z.array(z.string()),
    nativePlugin: z
      .boolean()
      .openapi({ description: 'The repository also has the layout of a native plugin.' }),
    latestVersion: z.string().nullable(),
    status: z.enum(['published', 'pending']),
    installCommand: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Package');
const FindingSchema = z
  .object({
    ruleId: z.string(),
    severity: z.enum(['critical', 'warning', 'info']),
    path: z.string(),
    line: z.number().int(),
    column: z.number().int(),
    message: z.string(),
  })
  .openapi('Finding');
const VersionSchema = z
  .object({
    version: z.string(),
    ref: z.string(),
    commit: z.string().nullable(),
    treeSha256: z.string().nullable(),
    scanBlocked: z.boolean(),
    findingCount: z.number().int(),
    indexedAt: z.string(),
  })
  .openapi('Version');
const ContentsSchema = z.object({
  skills: z.array(
    z.object({ name: z.string(), description: z.string().optional(), files: z.array(z.string()) }),
  ),
  agents: z.array(z.string()),
  commands: z.array(z.string()),
  instructions: z.array(z.string()),
  hooks: z.array(z.object({ name: z.string(), events: z.array(z.string()) })),
  mcpServers: z.array(
    z.object({
      name: z.string(),
      transport: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
    }),
  ),
});
const VersionDetailSchema = VersionSchema.extend({
  contents: ContentsSchema,
  files: z.array(
    z.object({ path: z.string(), size: z.number().int(), sha256: z.string(), hasContent: z.boolean() }),
  ),
  findings: z.array(FindingSchema),
}).openapi('VersionDetail');
const FileSchema = z
  .object({ path: z.string(), size: z.number().int(), sha256: z.string(), content: z.string().nullable() })
  .openapi('File');
const TokenSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    kind: z.enum(['session', 'api']),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Token');

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  400: json(ErrorSchema, 'Invalid request'),
  401: json(ErrorSchema, 'Authentication required'),
  403: json(ErrorSchema, 'Insufficient rights'),
  404: json(ErrorSchema, 'Not found'),
  409: json(ErrorSchema, 'Conflict'),
  422: json(ErrorSchema, 'Unprocessable content'),
};
const security = [{ bearerAuth: [] }];
const IdParam = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'id', in: 'path' }, example: 1 }),
});
const SlugParam = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .openapi({ param: { name: 'slug', in: 'path' }, example: 'default' }),
});

type Env = { Variables: { user: User | null } };

/** Builds the HTTP application. All access logic goes through `extensions.accessPolicy`. */
export function createApp(options: AppOptions): OpenAPIHono<Env> {
  const { db } = options;
  const ext = options.extensions ?? defaultExtensions();
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        return c.json(
          {
            error: {
              code: 'VALIDATION',
              message: `${issue?.path.join('.') || 'request'}: ${issue?.message ?? 'invalid'}`,
            },
          },
          400,
        );
      }
      return undefined;
    },
  });

  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof IndexError)
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 409 | 422);
    process.stderr.write(`${err.stack ?? err.message}\n`);
    return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'unknown route' } }, 404));

  // Authentification : fournisseurs premium d'abord, puis jeton porteur local.
  app.use('*', async (c, next) => {
    let user: User | null | undefined;
    for (const provider of ext.authProviders) {
      user = await provider.authenticate(c.req.raw);
      if (user !== undefined) break;
    }
    if (user === undefined) {
      const token = bearerToken(c.req.raw);
      user = token ? userFromToken(db, token) : null;
      if (token && !user) throw new HttpError(401, 'TOKEN_INVALID', 'invalid or expired token');
    }
    c.set('user', user);
    await next();
  });

  // --- Aides ---------------------------------------------------------------

  const audit = (
    c: Context<Env>,
    action: string,
    outcome: 'success' | 'denied' | 'failure',
    target?: string,
    details?: Record<string, unknown>,
  ): void => {
    void ext.auditSink.record({
      at: new Date().toISOString(),
      actor: c.get('user')?.email ?? null,
      action,
      outcome,
      ...(target ? { target } : {}),
      ...(details ? { details } : {}),
    });
  };
  const membership = (user: User | null, catalogId: number): Role | undefined => {
    if (!user) return undefined;
    const row = db
      .prepare('SELECT role FROM catalog_members WHERE catalog_id = ? AND user_id = ?')
      .get(catalogId, user.id) as { role: Role } | undefined;
    return row?.role;
  };
  const allowed = (c: Context<Env>, action: Action, catalog?: CatalogRow): boolean => {
    const user = c.get('user');
    const ref: CatalogRef | undefined = catalog
      ? { id: catalog.id, slug: catalog.slug, visibility: catalog.visibility }
      : undefined;
    return ext.accessPolicy.can(user, action, ref, catalog ? membership(user, catalog.id) : undefined);
  };
  const require = (c: Context<Env>, action: Action, catalog?: CatalogRow): void => {
    if (allowed(c, action, catalog)) return;
    audit(c, action, 'denied', catalog?.slug);
    if (!c.get('user')) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
    throw new HttpError(403, 'FORBIDDEN', 'insufficient rights for this action');
  };
  const catalogBySlug = (slug: string): CatalogRow | undefined =>
    db.prepare('SELECT * FROM catalogs WHERE slug = ?').get(slug) as CatalogRow | undefined;
  const catalogById = (id: number): CatalogRow =>
    db.prepare('SELECT * FROM catalogs WHERE id = ?').get(id) as CatalogRow;
  /** An unreadable private catalog cannot be told apart from a missing catalog. */
  const readableCatalog = (c: Context<Env>, slug: string): CatalogRow => {
    const catalog = catalogBySlug(slug);
    if (!catalog || !allowed(c, 'catalog.read', catalog))
      throw new HttpError(404, 'NOT_FOUND', `catalog "${slug}" not found`);
    return catalog;
  };
  const readablePackage = (c: Context<Env>, id: number): { pkg: PackageRow; catalog: CatalogRow } => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
    const catalog = pkg ? catalogById(pkg.catalog_id) : undefined;
    if (!pkg || !catalog || !allowed(c, 'package.read', catalog))
      throw new HttpError(404, 'NOT_FOUND', `paquet ${id} introuvable`);
    if (pkg.status === 'pending' && !allowed(c, 'package.publish', catalog))
      throw new HttpError(404, 'NOT_FOUND', `paquet ${id} introuvable`);
    return { pkg, catalog };
  };
  const packageDto = (pkg: PackageRow, catalogSlug: string): z.infer<typeof PackageSchema> => {
    const source = pkg.latest_ref ? `${pkg.source}#${pkg.latest_ref}` : pkg.source;
    return {
      id: pkg.id,
      catalog: catalogSlug,
      name: pkg.name,
      source,
      repository: pkg.source,
      description: pkg.description,
      license: pkg.license,
      tools: JSON.parse(pkg.tools) as Array<z.infer<typeof ToolSchema>>,
      tags: JSON.parse(pkg.tags) as string[],
      nativePlugin: pkg.native_plugin === 1,
      latestVersion: pkg.latest_version,
      status: pkg.status,
      installCommand: `ahub add ${source}`,
      updatedAt: pkg.updated_at,
    };
  };
  const versionDto = (v: VersionRow): z.infer<typeof VersionSchema> => ({
    version: v.version,
    ref: v.ref,
    commit: v.commit_sha,
    treeSha256: v.tree_sha256,
    scanBlocked: v.scan_blocked === 1,
    findingCount: (JSON.parse(v.findings) as unknown[]).length,
    indexedAt: v.indexed_at,
  });
  const catalogDto = (row: CatalogRow): z.infer<typeof CatalogSchema> => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    packageCount: (
      db
        .prepare("SELECT COUNT(*) AS n FROM packages WHERE catalog_id = ? AND status = 'published'")
        .get(row.id) as { n: number }
    ).n,
  });
  const currentUser = (c: Context<Env>): User => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
    return user;
  };

  // --- Divers --------------------------------------------------------------

  app.openapi(
    createRoute({
      method: 'get',
      path: '/healthz',
      tags: ['Misc'],
      summary: 'Server status',
      responses: {
        200: json(
          z.object({ status: z.literal('ok'), version: z.string(), edition: z.string() }),
          'The server responds',
        ),
      },
    }),
    (c) => c.json({ status: 'ok' as const, version: API_VERSION, edition: ext.edition }, 200),
  );

  // --- Comptes -------------------------------------------------------------

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/login',
      tags: ['Accounts'],
      summary: 'Opens a session',
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({ email: z.string().min(1), password: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({ token: z.string(), expiresAt: z.string().nullable(), user: UserSchema }),
          'Session opened',
        ),
        400: errors[400],
        401: errors[401],
      },
    }),
    (c) => {
      const { email, password } = c.req.valid('json');
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
      // Same answer whether or not the account exists.
      if (!row || !verifyPassword(password, row.password_hash)) {
        void ext.auditSink.record({
          at: new Date().toISOString(),
          actor: email,
          action: 'auth.login',
          outcome: 'failure',
        });
        throw new HttpError(401, 'CREDENTIALS_INVALID', 'incorrect address or password');
      }
      const t = issueToken(db, row.id, 'session', 'session');
      void ext.auditSink.record({
        at: new Date().toISOString(),
        actor: row.email,
        action: 'auth.login',
        outcome: 'success',
      });
      return c.json(
        { token: t.token, expiresAt: t.expiresAt, user: { id: row.id, email: row.email, role: row.role } },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/logout',
      tags: ['Accounts'],
      summary: 'Closes the current session',
      security,
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Session closed'), 401: errors[401] },
    }),
    (c) => {
      currentUser(c);
      const token = bearerToken(c.req.raw);
      if (token) db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hashToken(token));
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/me',
      tags: ['Accounts'],
      summary: 'Current user',
      security,
      responses: { 200: json(UserSchema, 'User'), 401: errors[401] },
    }),
    (c) => c.json(currentUser(c), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/tokens',
      tags: ['Accounts'],
      summary: 'Tokens of the current user',
      security,
      responses: { 200: json(z.object({ items: z.array(TokenSchema) }), 'Tokens'), 401: errors[401] },
    }),
    (c) => {
      const rows = db
        .prepare('SELECT id, name, kind, expires_at, created_at FROM tokens WHERE user_id = ? ORDER BY id')
        .all(currentUser(c).id) as Array<{
        id: number;
        name: string;
        kind: 'session' | 'api';
        expires_at: string | null;
        created_at: string;
      }>;
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            expiresAt: r.expires_at,
            createdAt: r.created_at,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/tokens',
      tags: ['Accounts'],
      summary: 'Creates an API token',
      description: 'The token is returned only once: only its hash is kept.',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(100) }) } },
        },
      },
      responses: {
        201: json(z.object({ id: z.number().int(), token: z.string() }), 'Token created'),
        400: errors[400],
        401: errors[401],
      },
    }),
    (c) => {
      const user = currentUser(c);
      const t = issueToken(db, user.id, 'api', c.req.valid('json').name);
      audit(c, 'token.create', 'success', String(t.id));
      return c.json({ id: t.id, token: t.token }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/tokens/{id}',
      tags: ['Accounts'],
      summary: 'Revokes a token',
      security,
      request: { params: IdParam },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Token revoked'),
        401: errors[401],
        404: errors[404],
      },
    }),
    (c) => {
      const info = db
        .prepare('DELETE FROM tokens WHERE id = ? AND user_id = ?')
        .run(c.req.valid('param').id, currentUser(c).id);
      if (info.changes === 0) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/users',
      tags: ['Accounts'],
      summary: 'Lists the users (admin)',
      security,
      responses: {
        200: json(z.object({ items: z.array(UserSchema) }), 'Users'),
        401: errors[401],
        403: errors[403],
      },
    }),
    (c) => {
      require(c, 'user.manage');
      return c.json(
        { items: db.prepare('SELECT id, email, role FROM users ORDER BY id').all() as User[] },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/users',
      tags: ['Accounts'],
      summary: 'Creates a user (admin)',
      security,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({ email: z.string().email(), password: z.string().min(12), role: RoleSchema }),
            },
          },
        },
      },
      responses: {
        201: json(UserSchema, 'User created'),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: errors[409],
      },
    }),
    (c) => {
      require(c, 'user.manage');
      const body = c.req.valid('json');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email.trim()))
        throw new HttpError(409, 'EMAIL_TAKEN', 'an account already exists for this address');
      const user = createUser(db, body.email, body.password, body.role);
      audit(c, 'user.create', 'success', user.email, { role: user.role });
      return c.json(user, 201);
    },
  );

  // --- Catalogues ----------------------------------------------------------

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/catalogs',
      tags: ['Catalogs'],
      summary: 'Lists the visible catalogs',
      responses: { 200: json(z.object({ items: z.array(CatalogSchema) }), 'Catalogs') },
    }),
    (c) => {
      const rows = (db.prepare('SELECT * FROM catalogs ORDER BY slug').all() as CatalogRow[]).filter((r) =>
        allowed(c, 'catalog.read', r),
      );
      return c.json({ items: rows.map(catalogDto) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/catalogs',
      tags: ['Catalogs'],
      summary: 'Creates a catalog (admin)',
      security,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({
                slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
                name: z.string().min(1).max(200),
                description: z.string().max(2000).optional(),
                visibility: z.enum(['public', 'private']).default('public'),
              }),
            },
          },
        },
      },
      responses: {
        201: json(CatalogSchema, 'Catalog created'),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: errors[409],
      },
    }),
    (c) => {
      require(c, 'catalog.create');
      const body = c.req.valid('json');
      if (catalogBySlug(body.slug))
        throw new HttpError(409, 'SLUG_TAKEN', `catalog "${body.slug}" already exists`);
      db.prepare(
        'INSERT INTO catalogs (slug, name, description, visibility, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(body.slug, body.name, body.description ?? null, body.visibility, new Date().toISOString());
      audit(c, 'catalog.create', 'success', body.slug, { visibility: body.visibility });
      return c.json(catalogDto(catalogBySlug(body.slug)!), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/catalogs/{slug}',
      tags: ['Catalogs'],
      summary: 'Details of a catalog',
      request: { params: SlugParam },
      responses: { 200: json(CatalogSchema, 'Catalog'), 404: errors[404] },
    }),
    (c) => c.json(catalogDto(readableCatalog(c, c.req.valid('param').slug)), 200),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/catalogs/{slug}/members/{userId}',
      tags: ['Catalogs'],
      summary: 'Gives a user a role in a catalog',
      security,
      request: {
        params: SlugParam.extend({
          userId: z.coerce
            .number()
            .int()
            .positive()
            .openapi({ param: { name: 'userId', in: 'path' } }),
        }),
        body: { required: true, content: { 'application/json': { schema: z.object({ role: RoleSchema }) } } },
      },
      responses: {
        200: json(
          z.object({ catalog: z.string(), userId: z.number().int(), role: RoleSchema }),
          'Role assigned',
        ),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
      },
    }),
    (c) => {
      const { slug, userId } = c.req.valid('param');
      const catalog = readableCatalog(c, slug);
      require(c, 'catalog.manage', catalog);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId))
        throw new HttpError(404, 'NOT_FOUND', 'user not found');
      const { role } = c.req.valid('json');
      db.prepare(
        'INSERT INTO catalog_members (catalog_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (catalog_id, user_id) DO UPDATE SET role = excluded.role',
      ).run(catalog.id, userId, role);
      audit(c, 'catalog.member.set', 'success', slug, { userId, role });
      return c.json({ catalog: slug, userId, role }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/catalogs/{slug}/members/{userId}',
      tags: ['Catalogs'],
      summary: 'Removes a member from a catalog',
      security,
      request: {
        params: SlugParam.extend({
          userId: z.coerce
            .number()
            .int()
            .positive()
            .openapi({ param: { name: 'userId', in: 'path' } }),
        }),
      },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Member removed'),
        401: errors[401],
        403: errors[403],
        404: errors[404],
      },
    }),
    (c) => {
      const { slug, userId } = c.req.valid('param');
      const catalog = readableCatalog(c, slug);
      require(c, 'catalog.manage', catalog);
      db.prepare('DELETE FROM catalog_members WHERE catalog_id = ? AND user_id = ?').run(catalog.id, userId);
      audit(c, 'catalog.member.remove', 'success', slug, { userId });
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/catalogs/{slug}/export/{format}',
      tags: ['Catalogs'],
      summary: 'Exports the catalog in the native marketplace format of a tool',
      description:
        'Produces the content of `.claude-plugin/marketplace.json` (Claude Code), `.agents/plugins/marketplace.json` (Codex), `.github/plugin/marketplace.json` (Copilot CLI) or `.cursor-plugin/marketplace.json` (Cursor). By default, only the packages that are also native plugins are exported.',
      request: {
        params: SlugParam.extend({ format: ToolSchema.openapi({ param: { name: 'format', in: 'path' } }) }),
        query: z.object({
          all: z
            .enum(['true', 'false'])
            .optional()
            .openapi({ description: 'Also includes the packages that are not native plugins.' }),
        }),
      },
      responses: {
        200: json(
          z.object({ path: z.string(), marketplace: z.record(z.unknown()), skipped: z.array(z.string()) }),
          'Marketplace exported',
        ),
        404: errors[404],
      },
    }),
    (c) => {
      const { slug, format } = c.req.valid('param');
      const catalog = readableCatalog(c, slug);
      const rows = db
        .prepare("SELECT * FROM packages WHERE catalog_id = ? AND status = 'published' ORDER BY name")
        .all(catalog.id) as PackageRow[];
      const input: Catalog = {
        name: catalog.slug,
        ...(catalog.description ? { description: catalog.description } : {}),
        owner: { name: catalog.name },
        entries: rows.map((r) => ({
          name: r.name,
          source: r.latest_ref ? `${r.source}#${r.latest_ref}` : r.source,
          ...(r.description ? { description: r.description } : {}),
          ...(r.latest_version ? { version: r.latest_version } : {}),
          ...(r.license ? { license: r.license } : {}),
          tags: JSON.parse(r.tags) as string[],
          nativePlugin: r.native_plugin === 1,
        })),
      };
      const out = exportMarketplace(input, format as MarketplaceFormat, {
        includeAll: c.req.valid('query').all === 'true',
      });
      return c.json(
        { path: out.path, marketplace: out.json, skipped: out.diagnostics.map((d) => d.message) },
        200,
      );
    },
  );

  // --- Paquets -------------------------------------------------------------

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/packages',
      tags: ['Packages'],
      summary: 'Lists and searches the packages',
      request: {
        query: z.object({
          q: z
            .string()
            .max(200)
            .optional()
            .openapi({ description: 'Words looked for in the name, the description and the tags.' }),
          tool: ToolSchema.optional().openapi({
            description: 'Keeps only the packages compatible with this tool.',
          }),
          catalog: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
      responses: {
        200: json(
          z.object({
            items: z.array(PackageSchema),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
          'Packages',
        ),
        400: errors[400],
      },
    }),
    (c) => {
      const { q, tool, catalog, page, pageSize } = c.req.valid('query');
      const catalogs = (db.prepare('SELECT * FROM catalogs').all() as CatalogRow[]).filter(
        (r) => allowed(c, 'package.read', r) && (!catalog || r.slug === catalog),
      );
      const slugById = new Map(catalogs.map((r) => [r.id, r.slug]));
      const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (
        db
          .prepare("SELECT * FROM packages WHERE status = 'published' ORDER BY name, id")
          .all() as PackageRow[]
      ).filter((r) => {
        if (!slugById.has(r.catalog_id)) return false;
        if (tool && !(JSON.parse(r.tools) as string[]).includes(tool)) return false;
        const hay =
          `${r.name} ${r.description ?? ''} ${(JSON.parse(r.tags) as string[]).join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
      const items = rows
        .slice((page - 1) * pageSize, page * pageSize)
        .map((r) => packageDto(r, slugById.get(r.catalog_id)!));
      return c.json({ items, total: rows.length, page, pageSize }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/packages',
      tags: ['Packages'],
      summary: 'Adds a repository to the catalog (editor)',
      description:
        'Reads the tags and the manifests of the repository, indexes the versions and their content, and scans each version. No code from the repository is executed.',
      security,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({
                source: z.string().min(1).openapi({
                  description:
                    'OpenAPM reference of the repository: `owner/repo`, `host/owner/repo/subfolder` or a git URL.',
                  example: 'agenteca/agenteca-registry/examples/hello-agent',
                }),
                catalog: z.string().default('default'),
                name: z
                  .string()
                  .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
                  .optional(),
                tags: z.array(z.string().max(40)).max(20).optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(
          z.object({
            package: PackageSchema,
            versions: z.array(z.string()),
            skipped: z.array(z.object({ ref: z.string(), reason: z.string() })),
          }),
          'Package indexed',
        ),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        409: errors[409],
        422: errors[422],
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const catalog = readableCatalog(c, body.catalog);
      require(c, 'package.publish', catalog);
      const user = currentUser(c);
      const result = await indexPackage(
        db,
        catalog.id,
        body.source,
        { ...(body.name ? { name: body.name } : {}), ...(body.tags ? { tags: body.tags } : {}) },
        options.indexer,
      );
      const review = await ext.publishGate.review({
        catalog: { id: catalog.id, slug: catalog.slug, visibility: catalog.visibility },
        packageName: result.name,
        source: body.source,
        actor: user,
        scanBlocked: result.scanBlocked,
      });
      if (review.decision === 'reject') {
        db.prepare('DELETE FROM packages WHERE id = ?').run(result.packageId);
        audit(c, 'package.publish', 'denied', result.name, { reason: review.reason });
        throw new HttpError(422, 'PUBLICATION_REJECTED', review.reason ?? 'publication refused');
      }
      db.prepare('UPDATE packages SET status = ? WHERE id = ?').run(
        review.decision === 'pending' ? 'pending' : 'published',
        result.packageId,
      );
      audit(c, 'package.publish', 'success', result.name, {
        catalog: catalog.slug,
        versions: result.versions,
        status: review.decision,
      });
      const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(result.packageId) as PackageRow;
      return c.json(
        { package: packageDto(pkg, catalog.slug), versions: result.versions, skipped: result.skipped },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/packages/{id}',
      tags: ['Packages'],
      summary: 'Details of a package',
      request: { params: IdParam },
      responses: { 200: json(PackageSchema, 'Package'), 404: errors[404] },
    }),
    (c) => {
      const { pkg, catalog } = readablePackage(c, c.req.valid('param').id);
      return c.json(packageDto(pkg, catalog.slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/packages/{id}/refresh',
      tags: ['Packages'],
      summary: 'Reads the repository of a package again (editor)',
      security,
      request: { params: IdParam },
      responses: {
        200: json(z.object({ package: PackageSchema, versions: z.array(z.string()) }), 'Package reindexed'),
        401: errors[401],
        403: errors[403],
        404: errors[404],
        422: errors[422],
      },
    }),
    async (c) => {
      const { pkg, catalog } = readablePackage(c, c.req.valid('param').id);
      require(c, 'package.publish', catalog);
      const result = await indexPackage(db, catalog.id, pkg.source, { name: pkg.name }, options.indexer);
      audit(c, 'package.refresh', 'success', pkg.name, { versions: result.versions });
      return c.json(
        {
          package: packageDto(
            db.prepare('SELECT * FROM packages WHERE id = ?').get(pkg.id) as PackageRow,
            catalog.slug,
          ),
          versions: result.versions,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/packages/{id}',
      tags: ['Packages'],
      summary: 'Removes a package from the catalog (admin)',
      security,
      request: { params: IdParam },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Package removed'),
        401: errors[401],
        403: errors[403],
        404: errors[404],
      },
    }),
    (c) => {
      const { pkg, catalog } = readablePackage(c, c.req.valid('param').id);
      require(c, 'package.delete', catalog);
      db.prepare('DELETE FROM packages WHERE id = ?').run(pkg.id);
      audit(c, 'package.delete', 'success', pkg.name, { catalog: catalog.slug });
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/packages/{id}/versions',
      tags: ['Packages'],
      summary: 'Indexed versions of a package',
      request: { params: IdParam },
      responses: { 200: json(z.object({ items: z.array(VersionSchema) }), 'Versions'), 404: errors[404] },
    }),
    (c) => {
      const { pkg } = readablePackage(c, c.req.valid('param').id);
      const rows = db
        .prepare('SELECT * FROM package_versions WHERE package_id = ? ORDER BY id')
        .all(pkg.id) as VersionRow[];
      return c.json({ items: rows.map(versionDto) }, 200);
    },
  );

  const VersionParam = IdParam.extend({
    version: z
      .string()
      .min(1)
      .openapi({ param: { name: 'version', in: 'path' }, example: '1.0.0' }),
  });
  const versionRow = (packageId: number, version: string): VersionRow => {
    const row = db
      .prepare('SELECT * FROM package_versions WHERE package_id = ? AND (version = ? OR ref = ?)')
      .get(packageId, version, version) as VersionRow | undefined;
    if (!row) throw new HttpError(404, 'NOT_FOUND', `version "${version}" not found`);
    return row;
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/packages/{id}/versions/{version}',
      tags: ['Packages'],
      summary: 'Content of a version: primitives, files, scan findings',
      request: { params: VersionParam },
      responses: { 200: json(VersionDetailSchema, 'Version'), 404: errors[404] },
    }),
    (c) => {
      const { id, version } = c.req.valid('param');
      const { pkg } = readablePackage(c, id);
      const v = versionRow(pkg.id, version);
      const files = db
        .prepare('SELECT * FROM package_files WHERE version_id = ? ORDER BY path')
        .all(v.id) as FileRow[];
      const summary = JSON.parse(v.summary) as z.infer<typeof ContentsSchema>;
      return c.json(
        {
          ...versionDto(v),
          contents: {
            skills: summary.skills,
            agents: summary.agents,
            commands: summary.commands,
            instructions: summary.instructions,
            hooks: summary.hooks,
            mcpServers: summary.mcpServers,
          },
          files: files.map((f) => ({
            path: f.path,
            size: f.size,
            sha256: f.sha256,
            hasContent: f.content !== null,
          })),
          findings: JSON.parse(v.findings) as Array<z.infer<typeof FindingSchema>>,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/packages/{id}/versions/{version}/file',
      tags: ['Packages'],
      summary: 'Text of a file, to read it before installing',
      request: {
        params: VersionParam,
        query: z.object({
          path: z.string().min(1).openapi({
            description: 'Path of the file in the package.',
            example: '.apm/skills/hello/SKILL.md',
          }),
        }),
      },
      responses: { 200: json(FileSchema, 'File'), 404: errors[404] },
    }),
    (c) => {
      const { id, version } = c.req.valid('param');
      const { pkg } = readablePackage(c, id);
      const v = versionRow(pkg.id, version);
      const f = db
        .prepare('SELECT * FROM package_files WHERE version_id = ? AND path = ?')
        .get(v.id, c.req.valid('query').path) as FileRow | undefined;
      if (!f) throw new HttpError(404, 'NOT_FOUND', 'file not found in this version');
      return c.json({ path: f.path, size: f.size, sha256: f.sha256, content: f.content }, 200);
    },
  );

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Session token (`POST /api/v1/auth/login`) or API token (`POST /api/v1/tokens`).',
  });
  app.doc31('/api/v1/openapi.json', openApiConfig(options.publicUrl));
  for (const p of ext.provisioning) p.mount(app);
  return app;
}

export function openApiConfig(publicUrl?: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Agenteca Server',
      version: API_VERSION,
      description:
        'Catalog of AI agents: search, package content before installation, publication, export to native marketplaces.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: publicUrl ?? 'http://localhost:8080' }],
  };
}

/** OpenAPI 3.1 document of the server, without starting a server. */
export function buildOpenApiDocument(db: Db): unknown {
  return createApp({ db }).getOpenAPI31Document(openApiConfig());
}
