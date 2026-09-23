// Every published package ships checked-in copies of the root LICENSE and NOTICE
// (npm tarballs only contain files from the package directory).
//   node scripts/check-legal-files.mjs          fails if a copy is missing or differs from the root file
//   node scripts/check-legal-files.mjs --write  refreshes the copies from the root files
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every workspace that is published to npm needs its own LICENSE and NOTICE in
// the tarball. Keep this in step with the `private: true` flags: a package that
// loses that flag has to be added here, or it ships without its licence.
const packages = [
  'packages/protocol',
  'packages/engine-web',
  'packages/react-native',
  'tools/osm',
  'tools/assets',
  'tools/tiles',
];
const files = ['LICENSE', 'NOTICE'];
const write = process.argv.includes('--write');

let stale = 0;
for (const pkg of packages) {
  for (const file of files) {
    const source = join(root, file);
    const copy = join(root, pkg, file);
    if (existsSync(copy) && readFileSync(copy).equals(readFileSync(source))) continue;
    if (write) {
      copyFileSync(source, copy);
      console.log(`check-legal-files: wrote ${pkg}/${file}`);
    } else {
      console.error(`check-legal-files: ${pkg}/${file} is missing or differs from the root ${file}`);
      stale++;
    }
  }
}
if (stale > 0) {
  console.error('check-legal-files: run `node scripts/check-legal-files.mjs --write`');
  process.exit(1);
}
if (!write) console.log(`check-legal-files: ${packages.length} packages carry the root ${files.join(' and ')}`);
