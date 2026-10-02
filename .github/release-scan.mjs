#!/usr/bin/env node
// The release scan (company decision 0038): a release that can touch people's keys scans the dependencies it would
// install when a lockfile changed since the last release, and stops on a finding. Run from the repository root, before
// anything installs (an install runs the packages' own scripts):
//
//   node .github/release-scan.mjs <lockfile>...
//
// The last release is the head of this release workflow's last successful run (RELEASE_SCAN_WORKFLOW, its file name
// under .github/workflows), read from GitHub with GITHUB_TOKEN, GH_TOKEN or `gh auth token`. The workflow scans every
// lockfile it installs before any of its jobs installs one, so a successful run is a scanned one. With no successful
// run yet, every package is new. RELEASE_SCAN_SINCE=<commit> names the last release directly.
//
// A lockfile unchanged since the last release is not scanned. A changed one is scanned whole by OSV-Scanner (OSV's
// database: GitHub and npm advisories, RustSec, PyPI and the malicious-package reports), and so is its last release's
// copy; an advisory on a package version the last release did not already carry is a finding and stops the release.
// Advisories the last release already carried are listed and do not stop it. Anything the scan cannot do (no token,
// no network, an unreadable lockfile) stops the release too.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// OSV-Scanner, pinned with its release's SHA256SUMS (github.com/google/osv-scanner/releases/tag/v2.6.0).
const OSV_VERSION = '2.6.0';
const OSV_SHA256 = {
  darwin_amd64: '60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca',
  darwin_arm64: '98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4',
  linux_amd64: 'ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108',
  linux_arm64: '2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4',
  'windows_amd64.exe': 'e0ed7644118b717b028c249ee9d3515024e55e8510747ca08906eb96765354d6',
  'windows_arm64.exe': 'ca1379da0e408279ef2c85cde0846a903495738a91c7b065a208048437c1686c',
};

const stop = (message) => {
  console.error(`release-scan: ${message}`);
  console.error('release-scan: the release stops here.');
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const lockfiles = process.argv.slice(2);
if (lockfiles.length === 0) stop('name the lockfiles this release installs: node .github/release-scan.mjs <lockfile>...');
for (const file of lockfiles) if (!existsSync(file)) stop(`${file} is not in this checkout`);

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return gh.status === 0 ? gh.stdout.trim() : '';
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git('remote', 'get-url', 'origin').trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  if (!match) stop(`cannot name the GitHub repository from origin ${url}; set GITHUB_REPOSITORY`);
  return match[1];
}

// The commit the last release shipped, or null before the first one.
async function lastRelease() {
  if (process.env.RELEASE_SCAN_SINCE) return { sha: process.env.RELEASE_SCAN_SINCE, what: 'RELEASE_SCAN_SINCE' };
  const workflow = process.env.RELEASE_SCAN_WORKFLOW;
  if (!workflow) stop('set RELEASE_SCAN_WORKFLOW to this release workflow\'s file name (or RELEASE_SCAN_SINCE to a commit)');
  const auth = token();
  if (!auth) stop('no GitHub token (GITHUB_TOKEN, GH_TOKEN or gh auth token) to read the last release');
  const repo = repository();
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=success&per_page=1`;
  let response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json' } });
  } catch (error) {
    stop(`could not reach GitHub for ${repo}'s last ${workflow} release: ${error.message}`);
  }
  if (!response.ok) stop(`GitHub answered ${response.status} for ${repo}'s last ${workflow} release (the job needs actions: read)`);
  const run = (await response.json()).workflow_runs?.[0];
  return run ? { sha: run.head_sha, what: `${workflow} run ${run.id}` } : null;
}

function baseCopy(sha, file) {
  const commit = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]);
  if (commit.status !== 0) {
    const fetched = spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], { encoding: 'utf8' });
    if (fetched.status !== 0) stop(`could not fetch the last release ${sha}: ${fetched.stderr.trim()}`);
  }
  const shown = spawnSync('git', ['show', `${sha}:./${file}`], { maxBuffer: 1 << 30 });
  return shown.status === 0 ? shown.stdout : null;
}

async function scanner() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const asset = `${os}_${arch}${os === 'windows' ? '.exe' : ''}`;
  const sha256 = OSV_SHA256[asset];
  if (!sha256) stop(`OSV-Scanner ${OSV_VERSION} has no build for ${process.platform} ${process.arch}`);
  const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), `osv-scanner-${OSV_VERSION}`);
  const binary = join(dir, `osv-scanner_${asset}`);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (!existsSync(binary) || digest(readFileSync(binary)) !== sha256) {
    const url = `https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_${asset}`;
    let bytes;
    try {
      const response = await fetch(url);
      if (!response.ok) stop(`downloading OSV-Scanner answered ${response.status}: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      stop(`could not download OSV-Scanner: ${error.message}`);
    }
    if (digest(bytes) !== sha256) stop(`OSV-Scanner ${asset} does not match its pinned SHA-256`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${binary}.part`, bytes);
    chmodSync(`${binary}.part`, 0o755);
    renameSync(`${binary}.part`, binary);
  }
  return binary;
}

// pkg@version (ecosystem) -> the advisories OSV reports on it, as { ids, aliases, severity, summary } groups.
function scan(binary, file) {
  const run = spawnSync(binary, ['scan', 'source', '--lockfile', file, '--format', 'json'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0 && run.status !== 1) stop(`OSV-Scanner could not scan ${file} (exit ${run.status}): ${run.stderr.trim().split('\n').slice(-3).join(' ')}`);
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    stop(`OSV-Scanner's report on ${file} is not JSON`);
  }
  const found = new Map();
  for (const result of report.results ?? []) {
    for (const { package: pkg, vulnerabilities = [], groups = [] } of result.packages ?? []) {
      const key = `${pkg.name}@${pkg.version} (${pkg.ecosystem})`;
      const summaries = new Map(vulnerabilities.map((v) => [v.id, v.summary ?? '']));
      const advisories = (groups.length ? groups : vulnerabilities.map((v) => ({ ids: [v.id], aliases: v.aliases ?? [] }))).map((g) => ({
        ids: g.ids,
        aliases: g.aliases ?? [],
        severity: g.max_severity ?? '',
        summary: g.ids.map((id) => summaries.get(id)).find(Boolean) ?? '',
      }));
      found.set(key, [...(found.get(key) ?? []), ...advisories]);
    }
  }
  return found;
}

const release = await lastRelease();
console.log(release ? `release-scan: the last release is ${release.sha} (${release.what})` : 'release-scan: no earlier release; every package is new');

const changed = [];
for (const file of lockfiles) {
  const base = release ? baseCopy(release.sha, file) : null;
  if (base && Buffer.compare(base, readFileSync(file)) === 0) console.log(`release-scan: ${file} is unchanged since the last release`);
  else changed.push({ file, base });
}
if (changed.length === 0) {
  console.log('release-scan: no lockfile changed; nothing to scan');
  process.exit(0);
}

const binary = await scanner();
const work = mkdtempSync(join(tmpdir(), 'release-scan-'));
let findings = 0;
for (const [index, { file, base }] of changed.entries()) {
  const now = scan(binary, file);
  let before = new Map();
  if (base) {
    // OSV-Scanner knows a lockfile by its name, so the last release's copy keeps it.
    const copy = join(work, String(index), basename(file));
    mkdirSync(join(work, String(index)), { recursive: true });
    writeFileSync(copy, base);
    before = scan(binary, copy);
  }
  const known = new Set([...before].flatMap(([key, advisories]) => advisories.flatMap((a) => a.ids.map((id) => `${key} ${id}`))));
  let carried = 0;
  const fresh = [];
  for (const [key, advisories] of now) {
    for (const advisory of advisories) {
      if (advisory.ids.every((id) => known.has(`${key} ${id}`))) carried++;
      else fresh.push({ key, ...advisory });
    }
  }
  console.log(`release-scan: ${file} changed${base ? '' : ' (new since the last release)'}: ${fresh.length} new finding(s), ${carried} advisory(ies) the last release already carried`);
  for (const { key, ids, aliases, severity, summary } of fresh) {
    console.log(`  ✗ ${key}: ${ids.join(', ')}${severity ? ` (severity ${severity})` : ''}${summary ? ` — ${summary}` : ''}`);
    for (const id of ids) console.log(`      https://osv.dev/${id}`);
    const also = aliases.filter((alias) => !ids.includes(alias));
    if (also.length) console.log(`      also ${also.join(', ')}`);
  }
  findings += fresh.length;
}
if (findings > 0) stop(`${findings} advisory(ies) on dependencies new in this release`);
console.log('release-scan: no new advisories; the release continues');
