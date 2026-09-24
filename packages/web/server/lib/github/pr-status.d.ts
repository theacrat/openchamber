import type { Octokit } from '@octokit/rest';

type Pull = Awaited<ReturnType<Octokit['rest']['pulls']['list']>>['data'][number];

export function resolveGitHubPrStatus(input: {
  octokit: Octokit;
  directory: string;
  branch: string;
  remoteName?: string;
  force?: boolean;
}): Promise<{
  repo: { owner: string; repo: string; url: string } | null;
  pr: Pull | null;
  defaultBranch: string | null;
  resolvedRemoteName: string | null;
}>;
