import { z } from 'zod';
import type { BridgeRequest, BridgeResponse } from './bridge';
import { getOctokitOrNull } from '../../web/server/lib/github/octokit.js';
import { resolveGitHubPrStatus } from '../../web/server/lib/github/pr-status.js';

const branchStatusRequest = z.object({
  directory: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  remote: z.string().trim().min(1).optional(),
  force: z.boolean().optional(),
});

export async function handleGitHubBridgeMessage(
  message: BridgeRequest,
  getClient = getOctokitOrNull,
): Promise<BridgeResponse | null> {
  if (message.type !== 'api:github/pr:status') return null;
  const { id, type } = message;
  try {
    const request = branchStatusRequest.parse(message.payload);
    const octokit = getClient();
    if (!octokit) return { id, type, success: true, data: { connected: false } };
    const resolved = await resolveGitHubPrStatus({ ...request, remoteName: request.remote, octokit });
    const pr = resolved.pr;
    const data = {
      connected: true,
      repo: resolved.repo,
      branch: request.branch,
      pr: pr ? {
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(pr.draft),
        base: pr.base.ref,
        head: pr.head.ref,
        headSha: pr.head.sha,
        mergedAt: pr.merged_at || null,
      } : null,
      checks: null,
      canMerge: false,
      defaultBranch: resolved.defaultBranch,
      resolvedRemoteName: resolved.resolvedRemoteName,
      fetchedAt: Date.now(),
    };
    return { id, type, success: true, data };
  } catch (error) {
    return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
