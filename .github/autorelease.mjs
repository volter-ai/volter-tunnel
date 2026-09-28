// Autorelease: every push to main releases what changed. Run by the publish
// workflow before its build and publish steps:
//
//   PACKAGES="<dir> …" [LOCKSTEP=1] [SOURCES="<path> …"] [PATHS="<dir>=<path>,… …"]
//   [PIN_FILES="<json> …"] [VERSION_TEXT="<file>=<package name> …"] node .github/autorelease.mjs
//
// A package is released when a commit since the last change to its version line
// touched its directory (or the paths PATHS names for it instead, or SOURCES,
// which every package is built from). Every
// package that depends on a released one through an exact pin or a `workspace:`
// range is released with it; LOCKSTEP=1 releases all of them together. Each
// released package moves to the next patch after the higher of its version on
// main and on npm (a version on main that npm lacks is released as it is);
// exact pins on it in the packages' manifests and in PIN_FILES follow, and so
// does its version string in each VERSION_TEXT file. The workflow
// then builds, publishes every version npm lacks, and commits the bump to main.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const list = (name) => (process.env[name] ?? '').split(/\s+/).filter(Boolean);
const dirs = list('PACKAGES');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  const text = readFileSync(file, 'utf8');
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? '  ';
  writeFileSync(file, JSON.stringify(value, null, indent) + '\n');
};
const onNpm = (name) => {
  try { return execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const parse = (version) => version.split('-')[0].split('.').map(Number);
const newer = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const nextPatch = (version) => { const [major, minor, patch] = parse(version); return `${major}.${minor}.${patch + 1}`; };

const packages = dirs.map((dir) => ({ dir, file: join(dir, 'package.json'), manifest: readJson(join(dir, 'package.json')) }));
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const fields = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];
const exact = (range) => /^\d/.test(range) || range.startsWith('workspace:');

function changed({ dir, file }) {
  const since = git('log', '-1', '--format=%H', '-G', '"version":', '--', file);
  if (!since) return true;
  const own = list('PATHS').find((entry) => entry.split('=')[0] === dir)?.split('=')[1].split(',');
  const paths = [...(own ?? [dir]), ...list('SOURCES')];
  return git('diff', '--name-only', since, 'HEAD', '--', ...paths, ':(exclude).github').length > 0;
}

let release = new Set(packages.filter(changed).map((pkg) => pkg.manifest.name));
if (list('LOCKSTEP').length && release.size) release = new Set(byName.keys());
for (let grew = true; grew;) {
  grew = false;
  for (const { manifest } of packages) {
    if (release.has(manifest.name)) continue;
    if (fields.some((field) => Object.entries(manifest[field] ?? {}).some(([dep, range]) => release.has(dep) && exact(range)))) {
      release.add(manifest.name); grew = true;
    }
  }
}

const bumped = new Map();
for (const name of release) {
  const { manifest } = byName.get(name);
  if (!onNpm(`${name}@${manifest.version}`)) { bumped.set(name, { from: manifest.version, to: manifest.version }); continue; }
  const latest = onNpm(name);
  const base = latest && newer(latest, manifest.version) ? latest : manifest.version;
  bumped.set(name, { from: manifest.version, to: nextPatch(base) });
}

function repin(value) {
  if (Array.isArray(value)) return value.map(repin);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const bump = bumped.get(key);
    out[key] = bump && typeof inner === 'string' && /^\d/.test(inner) ? bump.to : repin(inner);
  }
  return out;
}
for (const { file, manifest } of packages) {
  const next = { ...manifest };
  if (bumped.has(manifest.name)) next.version = bumped.get(manifest.name).to;
  for (const field of fields) if (next[field]) next[field] = repin(next[field]);
  if (JSON.stringify(next) !== JSON.stringify(manifest)) writeJson(file, next);
}
for (const file of list('PIN_FILES')) {
  const value = readJson(file); const next = repin(value);
  if (JSON.stringify(next) !== JSON.stringify(value)) writeJson(file, next);
}
for (const entry of list('VERSION_TEXT')) {
  const [file, name] = entry.split('=');
  const bump = bumped.get(name); if (!bump) continue;
  writeFileSync(file, readFileSync(file, 'utf8').split(`'${bump.from}'`).join(`'${bump.to}'`).split(`"${bump.from}"`).join(`"${bump.to}"`));
}

const released = [...bumped].map(([name, { to }]) => `${name}@${to}`);
process.stdout.write(released.length ? `releasing ${released.join(' ')}\n` : 'nothing changed since the last release\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `released=${released.join(' ')}\n`);
