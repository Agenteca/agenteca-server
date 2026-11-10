// Écrit openapi.json à partir des routes du code. Lancé par « npm run openapi ».
import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument, openDb } from '../dist/index.js';

const db = openDb(':memory:');
writeFileSync(
  new URL('../openapi.json', import.meta.url),
  JSON.stringify(buildOpenApiDocument(db), null, 2) + '\n',
);
db.close();
console.log('openapi.json écrit');
