import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { slackBindings } from "../../../db/schema/slack-binding";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createSlackClient, publishAppHome, buildAppHomeView } from "../index";
import { buildLoginUrl } from "./shared";
import { logger } from "../../logger";

const log = logger("slack:app-home");

interface AppHomeOpenedContext {
  workspaceId: string;
  userId: string;
}

/**
 * Handle an app_home_opened event from Slack
 *
 * Publishes the Home tab with account status, linked agents, and help info.
 */
export async function handleAppHomeOpened(
  context: AppHomeOpenedContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  try {
    // 1. Get workspace installation
    const [installation] = await globalThis.services.db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.slackWorkspaceId, context.workspaceId))
      .limit(1);

    if (!installation) {
      log.error("Slack installation not found for workspace", {
        workspaceId: context.workspaceId,
      });
      return;
    }

    // Decrypt bot token
    const botToken = decryptCredentialValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    // 2. Check if user is linked
    const [userLink] = await globalThis.services.db
      .select()
      .from(slackUserLinks)
      .where(
        and(
          eq(slackUserLinks.slackUserId, context.userId),
          eq(slackUserLinks.slackWorkspaceId, context.workspaceId),
        ),
      )
      .limit(1);

    if (!userLink) {
      // User not linked — show login prompt
      const loginUrl = buildLoginUrl(context.workspaceId, context.userId, "");
      const view = buildAppHomeView({
        isLinked: false,
        loginUrl,
      });
      await publishAppHome(client, context.userId, view);
      return;
    }

    // 3. Get user's bindings
    const bindings = await globalThis.services.db
      .select({
        agentName: slackBindings.agentName,
        description: slackBindings.description,
        enabled: slackBindings.enabled,
      })
      .from(slackBindings)
      .where(eq(slackBindings.slackUserLinkId, userLink.id));

    // 4. Build and publish home view
    const view = buildAppHomeView({
      isLinked: true,
      vm0UserId: userLink.vm0UserId,
      bindings,
    });
    await publishAppHome(client, context.userId, view);
  } catch (error) {
    log.error("Error handling app_home_opened", { error });
  }
}
