# Agenteca Server

REST API and index of the AI agent catalog. The server reads git repositories (tags, manifests, content), scans them and makes them searchable. It serves the `ahub` CLI, the `agenteca-web` site and the editor extensions.

> Status: 0.1.0. Neither the npm package nor the Docker image is published.

The server **reads** repositories; it runs nothing they contain.

## Getting started

With Docker, once the images are published:

```bash
docker compose up -d
```

Until then, from source, with the `agenteca-core`, `agenteca-server` and `agenteca-web` repositories side by side:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Without Docker:

```bash
npm install
```

```bash
npm run build
```

```bash
AGENTECA_ADMIN_EMAIL=me@example.org npm start
```

On first start, the server creates an administrator account. Without `AGENTECA_ADMIN_PASSWORD`, it generates a password and prints it **only once** in its logs.

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listening address |
| `AGENTECA_DATA_DIR` | `./data` | SQLite database and git cache |
| `AGENTECA_PUBLIC_URL` | `http://localhost:8080` | Public address, used in the OpenAPI document |
| `AGENTECA_ADMIN_EMAIL`, `AGENTECA_ADMIN_PASSWORD` | `admin@localhost`, generated | First administrator |
| `AGENTECA_EE_MODULE` | `@agenteca/ee` | Premium module to load if it is installed |

Put the server behind a TLS proxy: it does not handle HTTPS itself, and tokens travel in the `Authorization` header.

## API

The contract is [`openapi.json`](openapi.json) (OpenAPI 3.1), also served at `/api/v1/openapi.json`. It is generated from the code (`npm run openapi`) and a test fails if the committed file drifts from it.

API messages are in English: they are read by programs and administrators. Interfaces that show them to people (the web site, the extensions) translate their own texts.

| Route | Purpose | Access |
|---|---|---|
| `GET /api/v1/packages?q=&tool=&catalog=` | Search | Public for public catalogs |
| `GET /api/v1/packages/{id}` | Details | same |
| `GET /api/v1/packages/{id}/versions` | Indexed versions | same |
| `GET /api/v1/packages/{id}/versions/{version}` | Primitives, files, scan findings | same |
| `GET /api/v1/packages/{id}/versions/{version}/file?path=` | Text of a file | same |
| `POST /api/v1/packages` | Adds a repository to the catalog | Editor |
| `POST /api/v1/packages/{id}/refresh` | Reads the repository again | Editor |
| `DELETE /api/v1/packages/{id}` | Removes a package | Administrator |
| `GET /api/v1/catalogs/{slug}/export/{format}` | Native marketplace (`claude`, `codex`, `copilot`, `cursor`) | Same as reading |
| `GET`/`POST /api/v1/catalogs`, `PUT`/`DELETE …/members/{userId}` | Catalogs and members | Administrator to write |
| `POST /api/v1/auth/login`, `/logout`, `GET /api/v1/me` | Session | — |
| `GET`/`POST`/`DELETE /api/v1/tokens` | Personal API tokens | Signed in |
| `GET`/`POST /api/v1/users` | Accounts | Administrator |

Example:

```bash
curl -X POST http://localhost:8080/api/v1/packages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"source":"acme/code-review"}'
```

On the CLI side, a server is added as a registry:

```bash
ahub registry add https://catalog.example.org
```

## Roles and catalogs

Three roles, free of charge: **reader**, **editor** (publishes), **administrator** (removes, manages accounts and catalogs).

A catalog is **public** (readable without an account) or **private**. In a private catalog, only its members and the administrators have a role; for everyone else, it cannot be told apart from a missing catalog (404 answer).

## Export to native marketplaces

`/api/v1/catalogs/{slug}/export/{format}` produces the `marketplace.json` expected by Claude Code, Codex, Copilot CLI or Cursor.

By default, only the packages that are **also native plugins** are exported: these tools can only install their own plugin layout, not an OpenAPM package. `?all=true` exports everything; non-native packages stay installable with `ahub` or `apm`.

Limits: the Cursor format only documents local sources, so a Cursor export of remote repositories is empty. The fields of the `url` source in the Codex format are not confirmed by its documentation.

## Security

- Passwords hashed with scrypt; **only the hash** of tokens is stored.
- 12-hour sessions; API tokens without expiry, revocable.
- Sign-in answers the same way whether or not the account exists.
- Every indexed version is scanned (hidden Unicode, suspicious patterns); findings are exposed by the API.
- Audit log: one JSON line per event on standard output.

Not covered in 0.1.0: rate limiting of sign-in attempts (to be done at the proxy), token rotation, account deletion through the API.

## Premium edition

The server exposes five extension points in [`src/extensions.ts`](src/extensions.ts): `AuthProvider` (OIDC/SAML SSO), `AccessPolicy` (custom roles, per-team rights), `AuditSink` (audit log), `PublishGate` (validation before publication), `ProvisioningSource` (SCIM).

At start-up, the server tries to load `@agenteca/ee`. If it is absent, the default implementations apply and the community edition lacks nothing. If it is present but broken, the server refuses to start rather than run without the expected controls.

## Data model

SQLite, migrations applied at start-up (`src/db.ts`): `users`, `tokens`, `catalogs`, `catalog_members`, `packages`, `package_versions`, `package_files`.

## Development

```bash
npm test
```

The tests create real temporary git repositories and an in-memory database; no network access. In CI, `agenteca-core` is cloned next to this repository: no package published on npm is needed.

## License

AGPL-3.0. Contributions require a contributor license agreement (CLA), described in the `.github` repository of the organisation: it allows the proprietary premium module to plug into this server.
