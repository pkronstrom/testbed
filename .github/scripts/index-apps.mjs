// Regenerate apps.json by looking at what is actually deployed.
//
// An app directory is any top-level directory holding an index.html. Its
// metadata comes from its own app.json if it wrote one (the app repository
// owns that file); otherwise the directory name stands in, so a deploy that
// forgets the metadata still appears on the shelf rather than vanishing.
//
// Node's standard library only -- this repository has no dependencies to
// install, which keeps the deploy fast and the workflow readable.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['.git', '.github', 'node_modules']);

const apps = [];
for (const entry of readdirSync('.', { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
  const dir = entry.name;
  if (!existsSync(join(dir, 'index.html'))) continue;

  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'));
  } catch {
    // No app.json, or malformed: fall back to the directory name. A bad
    // metadata file must not take the whole shelf down.
  }

  apps.push({
    path: dir + '/',
    name: typeof meta.name === 'string' ? meta.name : dir,
    description: typeof meta.description === 'string' ? meta.description : '',
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    deployed: statSync(join(dir, 'index.html')).mtime.toISOString().slice(0, 10),
  });
}

// Alphabetical: stable across deploys, so the grid does not reshuffle itself
// every time one app happens to be pushed.
apps.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync('apps.json', JSON.stringify(apps, null, 2) + '\n');
console.log(`indexed ${apps.length} app(s): ${apps.map((a) => a.path).join(' ') || '(none)'}`);
