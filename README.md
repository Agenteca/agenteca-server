# Agenteca Server

API REST et index du catalogue d'agents IA. Le serveur lit des dépôts git (tags, manifestes, contenu), les scanne et les rend cherchables. Il sert la CLI `ahub`, le site `agenteca-web` et les extensions.

> État : 0.1.0. Ni le paquet npm ni l'image Docker ne sont publiés.

Le serveur **lit** les dépôts ; il n'exécute rien de ce qu'ils contiennent.

## Démarrer

Avec Docker, une fois les images publiées :

```bash
docker compose up -d
```

D'ici là, depuis les sources, avec les dépôts `agenteca-core`, `agenteca-server` et `agenteca-web` côte à côte :

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Sans Docker :

```bash
npm install
```

```bash
npm run build
```

```bash
AGENTECA_ADMIN_EMAIL=moi@exemple.org npm start
```

Au premier démarrage, le serveur crée un compte administrateur. Sans `AGENTECA_ADMIN_PASSWORD`, il génère un mot de passe et l'affiche **une seule fois** dans ses journaux.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Adresse d'écoute |
| `AGENTECA_DATA_DIR` | `./data` | Base SQLite et cache git |
| `AGENTECA_PUBLIC_URL` | `http://localhost:8080` | Adresse publique, reprise dans l'OpenAPI |
| `AGENTECA_ADMIN_EMAIL`, `AGENTECA_ADMIN_PASSWORD` | `admin@localhost`, généré | Premier administrateur |
| `AGENTECA_EE_MODULE` | `@agenteca/ee` | Module premium à charger s'il est installé |

Placez le serveur derrière un proxy TLS : il ne gère pas HTTPS lui-même, et les jetons circulent dans l'en-tête `Authorization`.

## API

Le contrat est [`openapi.json`](openapi.json) (OpenAPI 3.1), aussi servi sur `/api/v1/openapi.json`. Il est généré depuis le code (`npm run openapi`) et un test échoue si le fichier versionné s'en écarte.

| Route | Rôle | Accès |
|---|---|---|
| `GET /api/v1/packages?q=&tool=&catalog=` | Recherche | Public pour les catalogues publics |
| `GET /api/v1/packages/{id}` | Détail | idem |
| `GET /api/v1/packages/{id}/versions` | Versions indexées | idem |
| `GET /api/v1/packages/{id}/versions/{version}` | Primitives, fichiers, constats du scan | idem |
| `GET /api/v1/packages/{id}/versions/{version}/file?path=` | Texte d'un fichier | idem |
| `POST /api/v1/packages` | Ajoute un dépôt au catalogue | Éditeur |
| `POST /api/v1/packages/{id}/refresh` | Relit le dépôt | Éditeur |
| `DELETE /api/v1/packages/{id}` | Retire un paquet | Administrateur |
| `GET /api/v1/catalogs/{slug}/export/{format}` | Marketplace natif (`claude`, `codex`, `copilot`, `cursor`) | Comme la lecture |
| `GET`/`POST /api/v1/catalogs`, `PUT`/`DELETE …/members/{userId}` | Catalogues et membres | Administrateur pour écrire |
| `POST /api/v1/auth/login`, `/logout`, `GET /api/v1/me` | Session | — |
| `GET`/`POST`/`DELETE /api/v1/tokens` | Jetons d'API personnels | Connecté |
| `GET`/`POST /api/v1/users` | Comptes | Administrateur |

Exemple :

```bash
curl -X POST http://localhost:8080/api/v1/packages -H "Authorization: Bearer $JETON" -H 'Content-Type: application/json' -d '{"source":"acme/code-review"}'
```

Côté CLI, un serveur s'ajoute comme registre :

```bash
ahub registry add https://catalogue.exemple.org
```

## Rôles et catalogues

Trois rôles, gratuits : **lecteur**, **éditeur** (publie), **administrateur** (retire, gère comptes et catalogues).

Un catalogue est **public** (lisible sans compte) ou **privé**. Dans un catalogue privé, seuls ses membres et les administrateurs ont un rôle ; pour les autres, il est indiscernable d'un catalogue absent (réponse 404).

## Export en marketplaces natifs

`/api/v1/catalogs/{slug}/export/{format}` produit le `marketplace.json` attendu par Claude Code, Codex, Copilot CLI ou Cursor.

Par défaut, seuls les paquets qui sont **aussi des plugins natifs** sont exportés : ces outils ne savent installer que leur propre disposition de plugin, pas un paquet OpenAPM. `?all=true` exporte tout ; les paquets non natifs restent installables par `ahub` ou `apm`.

Limites : le format Cursor ne documente que des sources locales, donc un export Cursor de dépôts distants est vide. Les champs de la source `url` du format Codex ne sont pas confirmés par sa documentation.

## Sécurité

- Mots de passe hachés avec scrypt ; **seule l'empreinte** des jetons est stockée.
- Sessions de 12 heures ; jetons d'API sans expiration, révocables.
- La connexion répond de la même façon que le compte existe ou non.
- Chaque version indexée est scannée (Unicode caché, motifs suspects) ; les constats sont exposés par l'API.
- Journal d'audit : une ligne JSON par événement sur la sortie standard.

Non couvert en 0.1.0 : limitation du nombre de tentatives de connexion (à faire au niveau du proxy), rotation des jetons, suppression de comptes par l'API.

## Édition premium

Le serveur expose cinq points d'extension dans [`src/extensions.ts`](src/extensions.ts) : `AuthProvider` (SSO OIDC/SAML), `AccessPolicy` (rôles personnalisés, droits par équipe), `AuditSink` (journal d'audit), `PublishGate` (validation avant publication), `ProvisioningSource` (SCIM).

Au démarrage, le serveur tente de charger `@agenteca/ee`. S'il est absent, les implémentations par défaut s'appliquent et rien ne manque à l'édition communautaire. S'il est présent mais défaillant, le serveur refuse de démarrer plutôt que de tourner sans les contrôles attendus.

## Modèle de données

SQLite, migrations appliquées au démarrage (`src/db.ts`) : `users`, `tokens`, `catalogs`, `catalog_members`, `packages`, `package_versions`, `package_files`.

## Développement

```bash
npm test
```

Les tests créent de vrais dépôts git temporaires et une base en mémoire ; aucun accès réseau. En CI, `agenteca-core` est cloné à côté de ce dépôt : aucun paquet publié sur npm n'est nécessaire.

## Licence

AGPL-3.0. Les contributions demandent un accord de contribution (CLA), décrit dans le dépôt `.github` de l'organisation : il permet de brancher le module premium, propriétaire, sur ce serveur.
