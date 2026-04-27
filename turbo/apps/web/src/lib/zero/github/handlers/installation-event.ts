import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { getInstallationAccessToken } from "../github-app";
import { encryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { logger } from "../../../shared/logger";

const log = logger("github:installation-event");

// ─── GitHub Webhook Payload Schema ──────────────────────────────────

const gitHubInstallationAccountSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const gitHubInstallationSchema = z.object({
  id: z.number(),
  account: gitHubInstallationAccountSchema,
});

const gitHubSenderSchema = z.object({
  id: z.number(),
  login: z.string(),
});

export const gitHubInstallationEventSchema = z.object({
  action: z.string(),
  installation: gitHubInstallationSchema,
  sender: gitHubSenderSchema.optional(),
});

type GitHubInstallationEvent = z.infer<typeof gitHubInstallationEventSchema>;

// ─── Event Handler ──────────────────────────────────────────────────

/**
 * Handle `installation` webhook events.
 *
 * When action is "created", look for a pending record matching the
 * account ID and activate it with the installation access token.
 */
export async function handleInstallationCreatedEvent(
  payload: GitHubInstallationEvent,
): Promise<void> {
  if (payload.action !== "created") {
    log.debug("Ignoring installation event", { action: payload.action });
    return;
  }

  const { id: installationId, account } = payload.installation;
  const targetId = String(account.id);
  const ghInstallationId = String(installationId);

  // Look for a pending record matching this org/user
  const [pending] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.targetId, targetId),
        eq(githubInstallations.status, "pending"),
      ),
    )
    .limit(1);

  if (!pending) {
    log.debug("No pending installation found for target", { targetId });
    return;
  }

  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, SECRETS_ENCRYPTION_KEY } =
    env();

  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing), cannot activate pending installation",
    );
  }

  // Get installation access token
  const { token } = await getInstallationAccessToken(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    ghInstallationId,
  );

  const encryptedAccessToken = encryptSecretValue(
    token,
    SECRETS_ENCRYPTION_KEY,
  );

  // Set adminGithubUserId from webhook sender if available
  const adminGithubUserId = payload.sender ? String(payload.sender.id) : null;

  // Activate the pending record
  await globalThis.services.db
    .update(githubInstallations)
    .set({
      status: "active",
      installationId: ghInstallationId,
      encryptedAccessToken,
      targetName: account.login,
      adminGithubUserId,
      updatedAt: new Date(),
    })
    .where(eq(githubInstallations.id, pending.id));

  log.info("Activated pending GitHub installation", {
    installationId: ghInstallationId,
    targetId,
    recordId: pending.id,
  });
}
