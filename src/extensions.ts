/**
 * Extension points of the server. The premium repository `agenteca-ee` provides
 * implementations of them (SSO, SCIM, fine-grained rights, audit log, validation
 * before publication). Without it, the default implementations below apply
 * and the server works normally.
 */

export type Role = 'admin' | 'editor' | 'reader';

export interface User {
  id: number;
  email: string;
  role: Role;
}

export interface CatalogRef {
  id: number;
  slug: string;
  visibility: 'public' | 'private';
}

export type Action =
  | 'catalog.read'
  | 'catalog.create'
  | 'catalog.manage'
  | 'package.read'
  | 'package.publish'
  | 'package.delete'
  | 'user.manage';

/** Authentication: resolves the user of a request. The premium edition plugs OIDC and SAML into it. */
export interface AuthProvider {
  readonly name: string;
  /** Returns the user, `null` if the request is not authenticated, `undefined` to hand over to the next provider. */
  authenticate(request: Request): Promise<User | null | undefined>;
}

/** Access decision. The premium edition plugs custom roles and per-team or per-folder rights into it. */
export interface AccessPolicy {
  /** `membershipRole`: role of the user in this catalog, if they are a member. */
  can(user: User | null, action: Action, catalog?: CatalogRef, membershipRole?: Role): boolean;
}

export interface AuditEvent {
  at: string;
  actor: string | null;
  action: string;
  target?: string;
  outcome: 'allowed' | 'denied' | 'success' | 'failure';
  details?: Record<string, unknown>;
}

/** Audit log. By default: one JSON line per event on standard output. */
export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export interface PublishRequest {
  catalog: CatalogRef;
  packageName: string;
  source: string;
  actor: User;
  scanBlocked: boolean;
}

/** Validation workflow before publication. By default: immediate publication. */
export interface PublishGate {
  review(request: PublishRequest): Promise<{ decision: 'publish' | 'pending' | 'reject'; reason?: string }>;
}

/** Account provisioning (SCIM). No default implementation. */
export interface ProvisioningSource {
  readonly name: string;
  /** Mounts its routes (for example `/scim/v2`) on the application. */
  mount(app: unknown): void;
}

export interface ServerExtensions {
  authProviders: AuthProvider[];
  accessPolicy: AccessPolicy;
  auditSink: AuditSink;
  publishGate: PublishGate;
  provisioning: ProvisioningSource[];
  /** Name of the edition, exposed by `/healthz`. */
  edition: string;
}

const RANK: Record<Role, number> = { reader: 1, editor: 2, admin: 3 };

/** Free base policy: three roles (admin, editor, reader), public or private catalogs. */
export const defaultAccessPolicy: AccessPolicy = {
  can(user, action, catalog, membershipRole) {
    const global = user ? RANK[user.role] : 0;
    const member = membershipRole ? RANK[membershipRole] : 0;
    // Private catalog: only its members and the administrators have a role in it.
    // Public catalog: the global role applies, possibly raised by a member role.
    const effective =
      catalog?.visibility === 'private'
        ? Math.max(member, global === RANK.admin ? RANK.admin : 0)
        : Math.max(global, member);
    switch (action) {
      case 'catalog.read':
      case 'package.read':
        if (!catalog || catalog.visibility === 'public') return true;
        return effective >= RANK.reader;
      case 'package.publish':
        return effective >= RANK.editor;
      case 'package.delete':
      case 'catalog.manage':
        return effective >= RANK.admin;
      case 'catalog.create':
      case 'user.manage':
        return global >= RANK.admin;
    }
  },
};

export const stdoutAuditSink: AuditSink = {
  record(event) {
    process.stdout.write(`${JSON.stringify({ audit: event })}\n`);
  },
};

export const immediatePublishGate: PublishGate = {
  async review() {
    return { decision: 'publish' };
  },
};

export function defaultExtensions(): ServerExtensions {
  return {
    authProviders: [],
    accessPolicy: defaultAccessPolicy,
    auditSink: stdoutAuditSink,
    publishGate: immediatePublishGate,
    provisioning: [],
    edition: 'community',
  };
}

/**
 * Loads the premium module if it is installed. Its absence is not an error;
 * a module that is present but broken is one, so as not to start without the
 * expected access controls.
 */
export async function loadExtensions(
  moduleName = process.env.AGENTECA_EE_MODULE ?? '@agenteca/ee',
): Promise<ServerExtensions> {
  const base = defaultExtensions();
  let mod: {
    register?: (base: ServerExtensions) => Promise<Partial<ServerExtensions>> | Partial<ServerExtensions>;
  };
  try {
    mod = (await import(moduleName)) as typeof mod;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return base;
    throw e;
  }
  if (typeof mod.register !== 'function') {
    throw new Error(`module ${moduleName} does not export a register() function`);
  }
  return { ...base, ...(await mod.register(base)) };
}
