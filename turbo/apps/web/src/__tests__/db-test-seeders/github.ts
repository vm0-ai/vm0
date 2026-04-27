import { eq } from "drizzle-orm";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { initServices } from "../../lib/init-services";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { uniqueId, uniqueNumericId } from "../test-helpers";

// ---------------------------------------------------------------------------
// DB-direct seeders for GitHub integration test setup.
//
// Each function has a @why-db-direct annotation explaining why it cannot be
// replaced by an API call or webhook simulation.
// ---------------------------------------------------------------------------

/**
 * Insert a GitHub App installation record directly in the database.
 *
 * @why-db-direct Installations are created by the GitHub OAuth callback
 * route, which requires real GitHub API interaction (access tokens,
 * installation info). No API endpoint bootstraps installations from scratch.
 */
export async function insertTestGitHubInstallation(
  composeId: string,
  installationId?: string,
) {
  initServices();
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
 * @why-db-direct Pending installations are created by the OAuth callback
 * with setup_action=request, which requires a full OAuth redirect flow.
 */
export async function insertTestPendingGitHubInstallation(
  composeId: string,
  targetId: string,
  targetType: string = "Organization",
) {
  initServices();
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
 * Create a GitHub installation with a user link and admin role.
 *
 * Combines insertTestGitHubInstallation + insertTestGitHubUserLink
 * and sets adminGithubUserId so the linked user is the admin.
 *
 * @why-db-direct Combines installation creation, admin assignment, and
 * user link. No single API endpoint creates this composite state. OAuth
 * callback requires real GitHub API.
 */
export async function insertTestGitHubInstallationWithAdmin(
  composeId: string,
  vm0UserId: string,
) {
  initServices();
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
 * @why-db-direct User links are created as part of the OAuth callback
 * flow which requires real GitHub API interaction. No standalone API
 * creates user links.
 */
export async function insertTestGitHubUserLink(
  githubUserId: string,
  installationId: string,
  vm0UserId: string,
) {
  initServices();
  await globalThis.services.db
    .insert(githubUserLinks)
    .values({ githubUserId, installationId, vm0UserId })
    .onConflictDoNothing();
}

/**
 * Insert a GitHub issue session record directly in the database.
 *
 * @why-db-direct Issue sessions are created by the GitHub issue callback
 * handler during agent execution. Tests need precise control over session
 * state without running actual agents.
 */
export async function insertTestGitHubIssueSession(params: {
  userId: string;
  installationId: string;
  repo: string;
  issueNumber: number;
  agentSessionId: string;
  lastCommentId?: string;
}): Promise<{ id: string }> {
  initServices();
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
 * Insert a test GitHub installation for a compose (simpler variant).
 *
 * @why-db-direct Simpler installation seeder. Same justification as
 * insertTestGitHubInstallation — OAuth callback requires real GitHub API.
 */
export async function insertTestGithubInstallation(params: {
  composeId: string;
  installationId?: string;
}): Promise<{ id: string }> {
  initServices();
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
 *
 * @why-db-direct Simpler user link seeder. Same justification as
 * insertTestGitHubUserLink — OAuth callback requires real GitHub API.
 */
export async function insertTestGithubUserLink(params: {
  installationId: string;
  githubUserId: string;
  vm0UserId: string;
}): Promise<{ id: string }> {
  initServices();
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
