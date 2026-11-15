/**
 * Points d'extension du serveur. Le dépôt premium `agenteca-ee` en fournit des
 * implémentations (SSO, SCIM, droits fins, journal d'audit, validation avant
 * publication). Sans lui, les implémentations par défaut ci-dessous s'appliquent
 * et le serveur fonctionne normalement.
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

/** Authentification : résout l'utilisateur d'une requête. L'édition premium y branche OIDC et SAML. */
export interface AuthProvider {
  readonly name: string;
  /** Retourne l'utilisateur, `null` si la requête n'est pas authentifiée, `undefined` pour laisser la main au fournisseur suivant. */
  authenticate(request: Request): Promise<User | null | undefined>;
}

/** Décision d'accès. L'édition premium y branche rôles personnalisés et droits par équipe ou dossier. */
export interface AccessPolicy {
  /** `membershipRole` : rôle de l'utilisateur dans ce catalogue, s'il en est membre. */
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

/** Journal d'audit. Par défaut : une ligne JSON par événement sur la sortie standard. */
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

/** Circuit de validation avant publication. Par défaut : publication immédiate. */
export interface PublishGate {
  review(request: PublishRequest): Promise<{ decision: 'publish' | 'pending' | 'reject'; reason?: string }>;
}

/** Approvisionnement des comptes (SCIM). Aucune implémentation par défaut. */
export interface ProvisioningSource {
  readonly name: string;
  /** Monte ses routes (par exemple `/scim/v2`) sur l'application. */
  mount(app: unknown): void;
}

export interface ServerExtensions {
  authProviders: AuthProvider[];
  accessPolicy: AccessPolicy;
  auditSink: AuditSink;
  publishGate: PublishGate;
  provisioning: ProvisioningSource[];
  /** Nom de l'édition, exposé par `/healthz`. */
  edition: string;
}

const RANK: Record<Role, number> = { reader: 1, editor: 2, admin: 3 };

/** Politique de base, gratuite : trois rôles (admin, éditeur, lecteur), catalogues publics ou privés. */
export const defaultAccessPolicy: AccessPolicy = {
  can(user, action, catalog, membershipRole) {
    const global = user ? RANK[user.role] : 0;
    const member = membershipRole ? RANK[membershipRole] : 0;
    // Catalogue privé : seuls ses membres et les administrateurs y ont un rôle.
    // Catalogue public : le rôle global s'applique, éventuellement relevé par un rôle de membre.
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
 * Charge le module premium s'il est installé. Son absence n'est pas une erreur ;
 * un module présent mais défaillant en est une, pour ne pas démarrer sans les
 * contrôles d'accès attendus.
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
