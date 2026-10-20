#!/usr/bin/env node
// Prepare one lockstep protocol/engine-web release from a main-branch commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2] ?? 'prepare';
if (!['prepare', 'publish'].includes(mode)) throw new Error(`Unknown release mode: ${mode}`);
const registry = 'https://registry.npmjs.org';
const names = ['@open-yescoin/maprama-protocol', '@open-yescoin/maprama-engine-web'];
const paths = ['packages/protocol', 'packages/engine-web'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const semver = (version) => {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) throw new Error(`Expected a stable x.y.z version, received ${version}`);
  return parts.slice(1).map(Number);
};
const compare = (a, b) => {
  const left = semver(a);
  const right = semver(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};
const patch = (version) => {
  const [major, minor, revision] = semver(version);
  return `${major}.${minor}.${revision + 1}`;
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const npmVersions = (name) => {
  const raw = execFileSync('npm', ['view', name, 'versions', '--json', '--prefer-online', `--registry=${registry}`], { cwd: root, encoding: 'utf8' });
  const versions = JSON.parse(raw);
  const stable = (Array.isArray(versions) ? versions : [versions]).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  if (!stable.length) throw new Error(`No stable version found on npm for ${name}`);
  return stable.sort(compare).at(-1);
};
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const output = (values) => {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
};

const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
if (!tags.length) throw new Error('No version tag found; bootstrap a release tag before enabling automatic publishing');
const lastTag = tags[0];
const changed = spawnSync('git', ['diff', '--quiet', `${lastTag}..HEAD`, '--', ...paths], { cwd: root });
if (changed.status === null || changed.status > 1) throw new Error(`Unable to compare packages with ${lastTag}`);
if (changed.status === 0) {
  output({ release: false, reason: `No published package changes since ${lastTag}` });
  process.exit(0);
}

const protocolPath = join(root, 'packages/protocol/package.json');
const enginePath = join(root, 'packages/engine-web/package.json');
const current = readJson(protocolPath).version;
if (current !== readJson(enginePath).version) throw new Error('Protocol and engine-web versions must match');
semver(current);
const published = Object.fromEntries(names.map((name) => [name, npmVersions(name)]));
const latestPublished = Object.values(published).sort(compare).at(-1);
if (compare(current, latestPublished) < 0 || compare(current, lastTag.slice(1)) < 0) {
  throw new Error(`Repository version ${current} is behind npm or tag ${lastTag}; reconcile before releasing`);
}

const version = compare(current, lastTag.slice(1)) === 0 ? patch(current) : current;
if (compare(version, latestPublished) < 0) throw new Error(`Release version ${version} is behind npm ${latestPublished}`);
if (mode === 'publish' && version !== current) throw new Error(`Version ${version} has not been committed to main; run release preparation first`);
if (version !== current) {
  const workspacePatterns = readJson(join(root, 'package.json')).workspaces;
  const manifestPaths = workspacePatterns.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(root, pattern, 'package.json')];
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name, 'package.json'));
  });
  for (const path of manifestPaths) {
    const manifest = readJson(path);
    let dirty = false;
    if (names.includes(manifest.name)) { manifest.version = version; dirty = true; }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of names) {
        const value = manifest[section]?.[name];
        if (value === current || value === `^${current}` || value === `~${current}`) {
          manifest[section][name] = value.replace(current, version);
          dirty = true;
        }
      }
    }
    if (dirty) writeJson(path, manifest);
  }
}

if (names.every((name) => compare(published[name], version) >= 0)) {
  output({ release: true, version, bump: false, publish_protocol: false, publish_engine: false });
} else {
  output({ release: true, version, bump: version !== current, publish_protocol: compare(published[names[0]], version) < 0, publish_engine: compare(published[names[1]], version) < 0 });
}
