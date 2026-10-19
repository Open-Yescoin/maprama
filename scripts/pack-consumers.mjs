/** Build immutable consumer tarballs from a clean Maprama commit. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
const status = run('git', ['status', '--porcelain']).trim();
if (status) throw new Error('Commit Maprama source changes before packing consumer artifacts.');

const sourceCommit = run('git', ['rev-parse', 'HEAD']).trim();
const output = join(root, 'releases', `maprama-${sourceCommit.slice(0, 12)}`);
await mkdir(output, { recursive: true });
const packages = [
  { name: '@maprama/protocol', path: 'packages/protocol/package.json' },
  { name: '@maprama/engine-web', path: 'packages/engine-web/package.json' },
];
const artifacts = [];
for (const item of packages) {
  run('npm', ['run', 'build', '-w', item.name], { stdio: 'inherit' });
  const packed = JSON.parse(run('npm', ['pack', '--json', '-w', item.name, '--pack-destination', output]));
  const filename = packed[0]?.filename;
  if (!filename) throw new Error(`npm pack did not produce ${item.name}`);
  const body = await readFile(join(output, filename));
  const metadata = JSON.parse(await readFile(join(root, item.path), 'utf8'));
  artifacts.push({ name: item.name, version: metadata.version, filename, sha256: createHash('sha256').update(body).digest('hex') });
}
const manifest = { repository: 'https://github.com/Open-Yescoin/maprama', sourceCommit, artifacts };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${output}\n`);
