import { and, eq, sql } from "drizzle-orm";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { initServices } from "../../lib/init-services";

// ---------------------------------------------------------------------------
// Read-only assertion helpers for GitHub integration test verification.
// ---------------------------------------------------------------------------

/**
 * Find GitHub installations by installation ID.
 */
export async function findTestGitHubInstallations(installationId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

/**
 * Find a GitHub installation by its primary key.
 */
export async function findTestGitHubInstallationById(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .limit(1);
  return row;
}

/**
 * Find GitHub installations by target ID.
 */
export async function findTestGitHubInstallationsByTargetId(targetId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.targetId, targetId));
}

/**
 * Find a GitHub issue session by installation, repo, and issue number.
 */
export async function findTestGitHubIssueSession(
  installationId: string,
  repo: string,
  issueNumber: number,
) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, installationId),
        eq(githubIssueSessions.repo, repo),
        eq(githubIssueSessions.issueNumber, issueNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Count rows in github_user_links where vm0_user_id matches.
 */
export async function countGithubUserLinkRows(
  vm0UserId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM github_user_links WHERE vm0_user_id = ${vm0UserId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

/**
 * Find GitHub user links by VM0 user ID.
 */
export async function findTestGitHubUserLinksByVm0UserId(vm0UserId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(githubUserLinks)
    .where(eq(githubUserLinks.vm0UserId, vm0UserId));
}
