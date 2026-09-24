import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { Octokit } from '@octokit/rest';
import { handleGitHubBridgeMessage } from './bridge-github-runtime';

const directories: string[] = [];

function githubClient(respond: (url: URL) => Response): Octokit {
  const fixtureFetch: typeof fetch = async (input) => respond(new URL(input instanceof Request ? input.url : input));
  return new Octokit({ request: { fetch: fixtureFetch } });
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout() {
  const directory = await mkdtemp(path.join(tmpdir(), 'github-bridge-'));
  directories.push(directory);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.invalid');
  await writeFile(path.join(directory, 'file'), 'base');
  await git.add('file');
  await git.commit('base');
  const base = await git.revparse(['HEAD']);
  await git.checkoutLocalBranch('feature');
  await writeFile(path.join(directory, 'file'), 'feature');
  await git.add('file');
  await git.commit('feature');
  const sha = await git.revparse(['HEAD']);
  const owner = path.basename(directory).toLowerCase();
  await git.addRemote('origin', `https://github.com/${owner}/app.git`);
  return { directory, git, base, sha, owner };
}

test('disconnected status and invalid requests remain distinct', async () => {
  const message = { id: '1', type: 'api:github/pr:status', payload: { directory: '/repo', branch: 'feature' } };
  assert.deepEqual(await handleGitHubBridgeMessage(message, () => null), {
    id: '1', type: message.type, success: true, data: { connected: false },
  });
  assert.equal((await handleGitHubBridgeMessage({ ...message, payload: { branch: 'feature' } }, () => null))?.success, false);
  assert.equal(await handleGitHubBridgeMessage({ id: '2', type: 'other' }, () => null), null);
});

test('real resolver returns mergedAt and rejects history on a reused branch', async () => {
  const { directory, git, base, sha, owner } = await checkout();
  const client = githubClient((url) => {
    if (url.pathname === `/repos/${owner}/app`) return Response.json({ default_branch: 'main' });
    if (url.pathname === `/repos/${owner}/app/pulls`) return Response.json(url.searchParams.get('state') === 'open' ? [] : [{
      number: 12, title: 'Merged feature', html_url: `https://github.com/${owner}/app/pull/12`,
      state: 'closed', merged_at: '2026-09-01T00:00:00Z',
      head: { ref: 'feature', sha, repo: { owner: { login: owner }, name: 'app' } },
      base: { ref: 'main' },
    }]);
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const message = { id: '1', type: 'api:github/pr:status', payload: { directory, branch: 'feature' } };
  assert.partialDeepStrictEqual(await handleGitHubBridgeMessage(message, () => client), {
    success: true, data: { connected: true, pr: { number: 12, state: 'merged', mergedAt: '2026-09-01T00:00:00Z' } },
  });
  await git.reset(['--hard', base]);
  assert.partialDeepStrictEqual(await handleGitHubBridgeMessage(message, () => client), {
    success: true, data: { connected: true, pr: null },
  });
});

test('open upstream PR wins and a same-named contributor branch does not match', async () => {
  const { directory, sha, owner } = await checkout();
  const upstream = `${owner}-upstream`;
  const client = githubClient((url) => {
    if (url.pathname === `/repos/${owner}/app`) return Response.json({ default_branch: 'main', parent: { owner: { login: upstream }, name: 'app' } });
    if (url.pathname === `/repos/${upstream}/app`) return Response.json({ default_branch: 'main' });
    if (url.pathname.endsWith('/pulls')) {
      const pr = (number: number, source: string, state: 'open' | 'closed') => ({
        number, title: 'Feature', html_url: `https://github.com/${upstream}/app/pull/${number}`,
        state, merged_at: state === 'closed' ? '2026-09-01T00:00:00Z' : null,
        head: { ref: 'feature', sha, repo: { owner: { login: source }, name: 'app' } }, base: { ref: 'main' },
      });
      if (url.pathname === `/repos/${upstream}/app/pulls`) return Response.json([pr(99, 'unrelated-contributor', 'open'), pr(15, owner, 'open')]);
      return Response.json(url.searchParams.get('state') === 'open' ? [] : [pr(12, owner, 'closed')]);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  assert.partialDeepStrictEqual(await handleGitHubBridgeMessage({ id: '1', type: 'api:github/pr:status', payload: { directory, branch: 'feature' } }, () => client), {
    success: true, data: { repo: { owner: upstream }, pr: { number: 15, state: 'open', mergedAt: null } },
  });
});

test('GitHub failure is a bridge error rather than empty branch status', async () => {
  const { directory } = await checkout();
  const client = githubClient(() => Response.json({ message: 'Bad credentials' }, { status: 401 }));
  assert.partialDeepStrictEqual(await handleGitHubBridgeMessage({ id: '1', type: 'api:github/pr:status', payload: { directory, branch: 'feature' } }, () => client), {
    success: false, error: 'Bad credentials',
  });
});
