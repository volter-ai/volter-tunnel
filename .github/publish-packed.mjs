// npm does not run prepublishOnly when publishing a tarball. Keep the same
// source guard at the operator's packed-artifact publication door.
import './require-publish-branch.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: bun run publish:packed <approved-core.tgz> <approved-client.tgz> <approved-mcp.tgz>');
  process.exit(1);
}
// Resolve every artifact before publishing any. Hashes identify the exact bytes
// the operator must have scanned and received authority to publish.
const artifacts = files.map((file) => {
  const path = realpathSync(file);
  if (!path.endsWith('.tgz') || !statSync(path).isFile()) throw new Error('publish: name packed .tgz files only.');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  console.log(`publish: ${path} sha256 ${sha256}`);
  return path;
});
for (const artifact of artifacts) {
  const result = spawnSync('npm', ['publish', artifact, '--access', 'public'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
