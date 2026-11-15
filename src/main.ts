#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { bootstrapAdmin } from './auth.js';
import { openDb } from './db.js';
import { loadExtensions } from './extensions.js';

/**
 * Configuration par variables d'environnement :
 *   PORT (8080), HOST (0.0.0.0), AGENTECA_DATA_DIR (./data), AGENTECA_PUBLIC_URL,
 *   AGENTECA_ADMIN_EMAIL, AGENTECA_ADMIN_PASSWORD (premier démarrage seulement).
 */
async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.AGENTECA_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'agenteca.sqlite'));

  if (!db.prepare("SELECT 1 FROM catalogs WHERE slug = 'default'").get()) {
    db.prepare(
      "INSERT INTO catalogs (slug, name, description, visibility, created_at) VALUES ('default', 'Catalog', 'Default catalog', 'public', ?)",
    ).run(new Date().toISOString());
  }
  const admin = bootstrapAdmin(db, process.env.AGENTECA_ADMIN_EMAIL, process.env.AGENTECA_ADMIN_PASSWORD);
  if (admin?.generatedPassword) {
    // Affiché une seule fois : seule l'empreinte du mot de passe est conservée.
    process.stdout.write(
      `First start — administrator account created: ${admin.email}\nPassword (shown only once): ${admin.generatedPassword}\n`,
    );
  } else if (admin) {
    process.stdout.write(`First start — administrator account created: ${admin.email}\n`);
  }

  const extensions = await loadExtensions();
  const app = createApp({
    db,
    extensions,
    indexer: {
      env: { ...process.env, AHUB_CACHE_DIR: process.env.AHUB_CACHE_DIR ?? path.join(dataDir, 'cache') },
    },
    ...(process.env.AGENTECA_PUBLIC_URL ? { publicUrl: process.env.AGENTECA_PUBLIC_URL } : {}),
  });
  const port = Number(process.env.PORT ?? 8080);
  const hostname = process.env.HOST ?? '0.0.0.0';
  const server = serve({ fetch: app.fetch, port, hostname }, () => {
    process.stdout.write(
      `Agenteca Server (${extensions.edition} edition) listening on http://${hostname}:${port}\n`,
    );
  });
  const stop = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`Cannot start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
