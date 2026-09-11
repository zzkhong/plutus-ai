/**
 * Copies src/db/migrations into dist/db/migrations after tsc.
 *
 * tsc only emits .ts files, but drizzle's migrator reads the .sql files and
 * meta/_journal.json at runtime from a path relative to __dirname — so
 * without this step `npm run build && npm start` dies on the first
 * migrate() call with an empty migrations folder.
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'db', 'migrations');
const dest = path.join(__dirname, '..', 'dist', 'db', 'migrations');

if (!fs.existsSync(src)) {
  console.error(`No migrations folder at ${src} — nothing to copy.`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`Copied migrations to ${dest}`);
