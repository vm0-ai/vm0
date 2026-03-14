/**
 * Git smart HTTP protocol utilities
 *
 * Fetches repository HEAD commit SHA via the git smart HTTP protocol
 * (info/refs endpoint). This is NOT a GitHub API call — no tokens or
 * rate limits apply.
 */

import {
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core";

const REPO_REFS_URL = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}.git/info/refs?service=git-upload-pack`;

/**
 * Fetch the current HEAD commit SHA for refs/heads/main via git smart HTTP protocol.
 */
export async function fetchHeadCommitSha(): Promise<string> {
  const res = await fetch(REPO_REFS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch git refs: ${res.status}`);
  }
  const text = await res.text();
  return parseMainRef(text, DEFAULT_SKILLS_BRANCH);
}

/**
 * Parse pkt-line format response to extract a branch's commit SHA.
 *
 * The git smart HTTP info/refs response uses pkt-line encoding where each
 * line is prefixed with a 4-character hex length. Lines contain:
 *   {40-char SHA} {ref-name}
 */
function parseMainRef(pktLineText: string, branch: string): string {
  const refPattern = new RegExp(`([0-9a-f]{40})\\s+refs/heads/${branch}`);
  for (const line of pktLineText.split("\n")) {
    const match = line.match(refPattern);
    if (match) {
      return match[1]!;
    }
  }
  throw new Error(`refs/heads/${branch} not found in git refs`);
}
