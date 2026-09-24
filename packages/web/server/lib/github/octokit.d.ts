import type { Octokit } from '@octokit/rest';

export function createOctokit(token: string): Octokit;
export function getOctokitOrNull(): Octokit | null;
