/**
 * API-based GitHub Test Helpers
 *
 * These helpers create GitHub test fixtures for webhook handler tests.
 * Direct DB operations are used because GitHub App installations are created
 * via a GitHub OAuth callback that requires real GitHub API interaction.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { uniqueId } from "../test-helpers";
import { initServices } from "../../lib/init-services";
import { env } from "../../env";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { orgCache } from "../../db/schema/org-cache";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { githubInstallations } from "../../db/schema/github-installation";
import { githubUserLinks } from "../../db/schema/github-user-link";
import { userCache } from "../../db/schema/user-cache";
import { ensureStarterCreditGrant } from "../../lib/zero/credit/starter-grant-service";

interface GitHubInstallationResult {
  installation: {
    id: string;
    installationId: string;
    defaultComposeId: string;
  };
  ghInstallationId: number;
  compose: { id: string; name: string };
  versionId: string;
  userId: string;
  githubUserId: string;
  orgId: string;
}

/**
 * Given a GitHub App installation exists in the database.
 *
 * Creates all prerequisite records (org, compose, version, installation, user link)
 * needed for webhook handler tests.
 */
export async function givenGitHubInstallation(
  installationId?: number,
): Promise<GitHubInstallationResult> {
  const ghInstallationId =
    installationId ?? Math.floor(Math.random() * 1_000_000_000);

  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  const userId = uniqueId("gh-user");
  const githubUserId = String(Math.floor(Math.random() * 1_000_000_000));
  const orgSlug = uniqueId("org");

  // Pre-populate org cache for getOrgNameAndSlug()
  const orgId = uniqueId("org");
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug: orgSlug,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: orgSlug, cachedAt: new Date() },
    });

  // Ensure org row exists (source of truth for tier and default agent).
  // Routing through ensureStarterCreditGrant mirrors how real free-tier orgs
  // land their starter credits + a matching credit_expires_record during
  // onboarding (see STARTER_GRANT_AMOUNT for the current value).
  await globalThis.services.db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, orgId);
  });

  // Create compose
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: uniqueId("gh-agent"),
    })
    .returning();

  // Create zero agent (id = composeId after PK refactor)
  await globalThis.services.db
    .insert(zeroAgents)
    .values({ id: compose!.id, orgId, owner: userId, name: compose!.name })
    .onConflictDoNothing();

  // Create compose version (content-addressed: id is SHA-256 hash)
  const versionContent = {
    agents: {
      default: {
        model: "claude-sonnet-4-20250514",
        environment: { ANTHROPIC_API_KEY: "test-api-key" },
      },
    },
  };
  const versionId = crypto
    .createHash("sha256")
    .update(JSON.stringify(versionContent) + compose!.id)
    .digest("hex");

  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: versionContent,
    createdBy: userId,
  });

  // Update compose headVersionId
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, compose!.id));

  // Create installation (org-level, no userId)
  const encryptedToken = encryptSecretValue(
    "ghs_test_token",
    SECRETS_ENCRYPTION_KEY,
  );

  const [installation] = await globalThis.services.db
    .insert(githubInstallations)
    .values({
      installationId: String(ghInstallationId),
      encryptedAccessToken: encryptedToken,
      defaultComposeId: compose!.id,
      targetType: "Organization",
      targetId: String(Math.floor(Math.random() * 1_000_000_000)),
      targetName: "test-org",
      adminGithubUserId: githubUserId,
    })
    .returning();

  // Create user link
  await globalThis.services.db.insert(githubUserLinks).values({
    githubUserId,
    installationId: installation!.id,
    vm0UserId: userId,
  });

  // Pre-populate user_cache so getCachedUser() works without calling Clerk API
  await globalThis.services.db
    .insert(userCache)
    .values({
      userId,
      email: `${userId}@test.example.com`,
      name: userId,
      cachedAt: new Date(),
    })
    .onConflictDoNothing();

  return {
    installation: {
      id: installation!.id,
      installationId: installation!.installationId!,
      defaultComposeId: installation!.defaultComposeId,
    },
    ghInstallationId,
    compose: { id: compose!.id, name: compose!.name },
    versionId,
    userId,
    githubUserId,
    orgId,
  };
}
