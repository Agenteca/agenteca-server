import {
  canonicalDepString,
  createContext,
  type DepRef,
  inspectPackage,
  lsRemote,
  parseDepString,
  type ProjectContext,
  repoLocation,
  sha256Hex,
  SUPPORTED_TARGETS,
  versionsFromTags,
} from '@agenteca/core';
import os from 'node:os';
import semver from 'semver';
import type { Db, PackageRow } from './db.js';

export interface IndexerOptions {
  env?: NodeJS.ProcessEnv;
  /** Maximum number of versions (most recent SemVer tags) indexed per package. */
  maxVersions?: number;
}

export interface IndexResult {
  packageId: number;
  name: string;
  versions: string[];
  scanBlocked: boolean;
  skipped: Array<{ ref: string; reason: string }>;
}

export class IndexError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function indexerContext(env: NodeJS.ProcessEnv | undefined): ProjectContext {
  return createContext({ cwd: os.tmpdir(), env: env ?? process.env });
}

/** Reads the source without the reference: the server indexes several versions of the same repository. */
export function parseSource(source: string): { ref: DepRef; base: string } {
  let ref: DepRef;
  try {
    ref = parseDepString(source);
  } catch (e) {
    throw new IndexError(422, 'SOURCE_INVALID', e instanceof Error ? e.message : String(e));
  }
  if (ref.kind !== 'git')
    throw new IndexError(
      422,
      'SOURCE_INVALID',
      'the source must be a git repository (owner/repo or URL), not a local path',
    );
  const { ref: _ref, ...rest } = ref;
  return { ref, base: canonicalDepString(rest) };
}

/**
 * Indexes a repository: reads its tags, then for each version kept reads the
 * manifest, the content and the result of the scan. Nothing is executed.
 */
export async function indexPackage(
  db: Db,
  catalogId: number,
  source: string,
  overrides: { name?: string; tags?: string[]; tools?: string[]; status?: 'published' | 'pending' },
  opts: IndexerOptions = {},
): Promise<IndexResult> {
  const { ref, base } = parseSource(source);
  const ctx = indexerContext(opts.env);
  const shortName = ref.virtualPath ? ref.virtualPath.split('/').pop()! : ref.repo!;

  let refs;
  try {
    refs = await lsRemote(repoLocation(ref, ctx.git));
  } catch (e) {
    throw new IndexError(
      422,
      'SOURCE_UNREACHABLE',
      `repository unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const versions = versionsFromTags(refs.tags.keys(), shortName);
  const ordered = semver.rsort([...versions.keys()]).filter((v) => semver.prerelease(v) === null);
  const targets: Array<{ version: string; ref: string | undefined }> = ordered
    .slice(0, opts.maxVersions ?? 10)
    .map((v) => ({ version: v, ref: versions.get(v)! }));
  // Without a SemVer tag, the default branch stands in for a version.
  if (targets.length === 0) targets.push({ version: refs.defaultBranch ?? 'HEAD', ref: ref.ref });

  const inspected: Array<{ version: string; ref: string; info: Awaited<ReturnType<typeof inspectPackage>> }> =
    [];
  const skipped: IndexResult['skipped'] = [];
  for (const t of targets) {
    const dep = t.ref ? `${base}#${t.ref}` : base;
    try {
      inspected.push({
        version: t.version,
        ref: t.ref ?? refs.defaultBranch ?? 'HEAD',
        info: await inspectPackage(ctx, dep, { includeText: true }),
      });
    } catch (e) {
      skipped.push({ ref: t.ref ?? 'HEAD', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (inspected.length === 0) {
    throw new IndexError(
      422,
      'PACKAGE_INVALID',
      `no readable version: ${skipped.map((s) => `${s.ref} — ${s.reason}`).join('; ')}`,
    );
  }

  const latest = inspected[0]!;
  const summary = latest.info.summary;
  const name = overrides.name ?? summary.name;
  const declared = summary.declaredTargets?.filter((t) =>
    (SUPPORTED_TARGETS as readonly string[]).includes(t),
  );
  // Tools declared by the package itself; failing that, every supported tool. A publisher can state
  // them explicitly (a native plugin of a single tool declares no target), and that choice is kept.
  const inferredTools =
    declared && declared.length > 0 && !summary.declaredTargets!.includes('all')
      ? declared
      : [...SUPPORTED_TARGETS];
  const hasTags = ordered.length > 0;
  const now = new Date().toISOString();

  const write = db.transaction((): number => {
    const existing = db
      .prepare('SELECT * FROM packages WHERE catalog_id = ? AND name = ?')
      .get(catalogId, name) as PackageRow | undefined;
    let packageId: number;
    const statedTools: string[] | null =
      overrides.tools ??
      (existing?.declared_tools ? (JSON.parse(existing.declared_tools) as string[]) : null);
    const tools = statedTools ?? inferredTools;
    const values = {
      source: base,
      description: summary.description ?? null,
      license: summary.license ?? null,
      tools: JSON.stringify(tools),
      declared_tools: statedTools ? JSON.stringify(statedTools) : null,
      tags: JSON.stringify(overrides.tags ?? (existing ? (JSON.parse(existing.tags) as string[]) : [])),
      native_plugin: summary.layout === 'plugin' ? 1 : 0,
      latest_version: latest.version,
      latest_ref: hasTags ? latest.ref : null,
      status: overrides.status ?? existing?.status ?? 'published',
    };
    if (existing) {
      if (existing.source !== base)
        throw new IndexError(
          409,
          'NAME_TAKEN',
          `a package "${name}" already exists in this catalog with another source; give this one another name with the "name" field`,
        );
      packageId = existing.id;
      db.prepare(
        `UPDATE packages SET description=@description, license=@license, tools=@tools, declared_tools=@declared_tools, tags=@tags, native_plugin=@native_plugin,
         latest_version=@latest_version, latest_ref=@latest_ref, status=@status, updated_at=@now WHERE id=@id`,
      ).run({ ...values, now, id: packageId });
    } else {
      const info = db
        .prepare(
          `INSERT INTO packages (catalog_id, name, source, description, license, tools, declared_tools, tags, native_plugin, latest_version, latest_ref, status, created_at, updated_at)
           VALUES (@catalog_id, @name, @source, @description, @license, @tools, @declared_tools, @tags, @native_plugin, @latest_version, @latest_ref, @status, @now, @now)`,
        )
        .run({ ...values, catalog_id: catalogId, name, now });
      packageId = Number(info.lastInsertRowid);
    }
    for (const v of inspected) {
      db.prepare('DELETE FROM package_versions WHERE package_id = ? AND ref = ?').run(packageId, v.ref);
      const vi = db
        .prepare(
          `INSERT INTO package_versions (package_id, version, ref, commit_sha, tree_sha256, summary, scan_blocked, findings, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          packageId,
          v.version,
          v.ref,
          v.info.commit ?? null,
          v.info.treeSha256 ?? null,
          JSON.stringify(v.info.summary),
          v.info.blocked ? 1 : 0,
          JSON.stringify(v.info.findings),
          now,
        );
      const insertFile = db.prepare(
        'INSERT INTO package_files (version_id, path, size, sha256, content) VALUES (?, ?, ?, ?, ?)',
      );
      for (const f of v.info.files) {
        insertFile.run(
          Number(vi.lastInsertRowid),
          f.path,
          f.size,
          sha256Hex(f.text ?? `${f.path}:${f.size}`),
          f.text ?? null,
        );
      }
    }
    return packageId;
  });
  const packageId = write();
  return {
    packageId,
    name,
    versions: inspected.map((v) => v.version),
    scanBlocked: latest.info.blocked,
    skipped,
  };
}
