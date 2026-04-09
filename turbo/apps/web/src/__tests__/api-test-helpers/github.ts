import { and, eq, sql } from "drizzle-orm";
import { githubInstallations } from "../../db/schema/github-installation";
import { githubUserLinks } from "../../db/schema/github-user-link";
import { githubIssueSessions } from "../../db/schema/github-issue-session";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { uniqueId, uniqueNumericId } from "../test-helpers";

/**
 * Insert a GitHub App installation record directly in the database.
 *
 * Direct DB insert is required because installations are created by the
 * GitHub OAuth callback route, which requires real GitHub API interaction.
 */
export async function insertTestGitHubInstallation(
  composeId: string,
  installationId?: string,
) {
  const id = installationId ?? uniqueNumericId();
  const encryptedToken = encryptSecretValue(
    "ghs_test_token",
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  const [row] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      installationId: id,
      encryptedAccessToken: encryptedToken,
      defaultComposeId: composeId,
    })
    .returning();

  return row!;
}

/**
 * Insert a pending GitHub installation record directly in the database.
 *
 * Direct DB insert is required because pending installations are created by the
 * GitHub OAuth callback route with setup_action=request, which requires a full
 * OAuth redirect flow.
 */
export async function insertTestPendingGitHubInstallation(
  composeId: string,
  targetId: string,
  targetType: string = "Organization",
) {
  const [row] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType,
      defaultComposeId: composeId,
    })
    .returning();

  return row!;
}

/**
 * Find GitHub installations by installation ID.
 *
 * Direct DB read is required because the GET endpoint filters by userId
 * (authenticated user) and does not support querying by installation ID.
 */
export async function findTestGitHubInstallations(installationId: string) {
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

/**
 * Find a GitHub installation by its primary key.
 *
 * Direct DB read is required because the DELETE endpoint removes the record,
 * and we need to verify deletion by checking the row no longer exists.
 */
export async function findTestGitHubInstallationById(id: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .limit(1);
  return row;
}

/**
 * Create a GitHub installation with a user link and admin role.
 *
 * Combines insertTestGitHubInstallation + insertTestGitHubUserLink
 * and sets adminGithubUserId so the linked user is the admin.
 */
export async function insertTestGitHubInstallationWithAdmin(
  composeId: string,
  vm0UserId: string,
) {
  const githubUserId = uniqueId("gh-uid");
  const installation = await insertTestGitHubInstallation(composeId);

  // Set admin to the github user
  await globalThis.services.db
    .update(githubInstallations)
    .set({ adminGithubUserId: githubUserId })
    .where(eq(githubInstallations.id, installation.id));

  // Create user link inline (maps GitHub user to VM0 user for this installation)
  await globalThis.services.db
    .insert(githubUserLinks)
    .values({
      githubUserId,
      installationId: installation.id,
      vm0UserId,
    })
    .onConflictDoNothing();

  return { installation, githubUserId };
}

/**
 * Insert a GitHub user link record directly in the database.
 *
 * Direct DB insert is required because user links are created by the
 * GitHub OAuth callback which requires real GitHub API interaction.
 * This helper creates a link between a GitHub user and a VM0 user
 * for a given installation, used to test non-admin authorization paths.
 */
export async function insertTestGitHubUserLink(
  githubUserId: string,
  installationId: string,
  vm0UserId: string,
) {
  await globalThis.services.db
    .insert(githubUserLinks)
    .values({ githubUserId, installationId, vm0UserId })
    .onConflictDoNothing();
}

/**
 * Find GitHub installations by target ID.
 *
 * Direct DB read is required because pending installations have no
 * installation_id to query by, and the GET endpoint requires auth context.
 */
export async function findTestGitHubInstallationsByTargetId(targetId: string) {
  return globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.targetId, targetId));
}

/**
 * Insert a GitHub issue session record directly in the database.
 *
 * Direct DB insert is required because issue sessions are created by the
 * callback handler, and we need to pre-populate them for update path tests.
 */
export async function insertTestGitHubIssueSession(params: {
  userId: string;
  installationId: string;
  repo: string;
  issueNumber: number;
  agentSessionId: string;
  lastCommentId?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(githubIssueSessions)
    .values({
      userId: params.userId,
      installationId: params.installationId,
      repo: params.repo,
      issueNumber: params.issueNumber,
      agentSessionId: params.agentSessionId,
      lastCommentId: params.lastCommentId,
    })
    .returning({ id: githubIssueSessions.id });
  return row!;
}

/**
 * Find a GitHub issue session by installation, repo, and issue number.
 *
 * Direct DB read is required because there is no API endpoint to query
 * issue sessions. Used to verify callback handler creates/updates records.
 */
export async function findTestGitHubIssueSession(
  installationId: string,
  repo: string,
  issueNumber: number,
) {
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
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM github_user_links WHERE vm0_user_id = ${vm0UserId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

export async function findTestGitHubUserLinksByVm0UserId(vm0UserId: string) {
  return globalThis.services.db
    .select()
    .from(githubUserLinks)
    .where(eq(githubUserLinks.vm0UserId, vm0UserId));
}

/**
 * Insert a test GitHub installation for a compose (simpler variant).
 */
export async function insertTestGithubInstallation(params: {
  composeId: string;
  installationId?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      defaultComposeId: params.composeId,
      installationId: params.installationId ?? `gh-inst-${Date.now()}`,
    })
    .returning({ id: githubInstallations.id });
  return row!;
}

/**
 * Insert a test GitHub user link (simpler variant).
 */
export async function insertTestGithubUserLink(params: {
  installationId: string;
  githubUserId: string;
  vm0UserId: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(githubUserLinks)
    .values({
      installationId: params.installationId,
      githubUserId: params.githubUserId,
      vm0UserId: params.vm0UserId,
    })
    .returning({ id: githubUserLinks.id });
  return row!;
}
