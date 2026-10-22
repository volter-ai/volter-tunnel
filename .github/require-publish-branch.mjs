// Publication is an authorized operator act from the pushed publish branch (D9).
// This guard reads Git only; it never advances a ref or writes version commits.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stop = (message) => {
  console.error(`publish: ${message}`);
  process.exit(1);
};
const git = (what, ...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).trim();
  } catch {
    stop(`could not read ${what}; publication stopped.`);
  }
};

const branch = git('the current branch', 'branch', '--show-current');
if (branch !== 'publish') stop('npm publication requires the publish branch; main, feature branches and detached HEAD are refused.');
if (git('the working tree', 'status', '--porcelain', '--untracked-files=normal')) {
  stop('commit or remove working-tree changes before publication.');
}
const head = git('HEAD', 'rev-parse', 'HEAD');
// Read the server rather than trusting a possibly stale origin/publish ref.
const remote = git('origin/publish', 'ls-remote', '--exit-code', 'origin', 'refs/heads/publish');
if (remote !== `${head}\trefs/heads/publish`) stop('HEAD must equal the pushed origin/publish commit.');
console.log(`publish: clean publish branch at ${head}; explicit release authorization is still required.`);
