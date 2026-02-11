import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { slackUserLinks } from "../../../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  refreshAppHome,
} from "../../../../../src/lib/slack";
import {
  ensureScopeAndArtifact,
  getWorkspaceAgent,
} from "../../../../../src/lib/slack/handlers/shared";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { addPermission } from "../../../../../src/lib/agent/permission-service";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:slack:link");

/**
 * GET /api/integrations/slack/link
 *
 * Check if a Slack user is already linked to the current VM0 user.
 * Query params: slackUserId, workspaceId
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const slackUserId = url.searchParams.get("slackUserId");
  const workspaceId = url.searchParams.get("workspaceId");

  if (!slackUserId || !workspaceId) {
    return NextResponse.json(
      {
        error: {
          message: "Missing slackUserId or workspaceId",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const [existingLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (existingLink) {
    const [installation] = await globalThis.services.db
      .select({ workspaceName: slackInstallations.slackWorkspaceName })
      .from(slackInstallations)
      .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
      .limit(1);

    return NextResponse.json({
      isLinked: true,
      workspaceName: installation?.workspaceName ?? null,
    });
  }

  return NextResponse.json({ isLinked: false });
}

/**
 * POST /api/integrations/slack/link
 *
 * Link a Slack user to the current VM0 user.
 * Body: { slackUserId: string, workspaceId: string, channelId?: string }
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const body = (await request.json()) as {
    slackUserId?: string;
    workspaceId?: string;
    channelId?: string;
  };

  const { slackUserId, workspaceId, channelId } = body;

  if (!slackUserId || !workspaceId) {
    return NextResponse.json(
      {
        error: {
          message: "Missing slackUserId or workspaceId",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Check if the workspace installation exists
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "Workspace not found. Please install the Slack app first.",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  // Check if this Slack user is already linked
  const [existingLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (existingLink) {
    if (existingLink.vm0UserId === userId) {
      if (channelId) {
        await sendSuccessMessage(
          installation.encryptedBotToken,
          channelId,
          slackUserId,
          installation.defaultComposeId,
        ).catch((error) => {
          log.warn("Failed to send success message", { error });
        });
      }
      return NextResponse.json({ success: true, alreadyLinked: true });
    }
    return NextResponse.json(
      {
        error: {
          message:
            "This Slack account is already linked to a different VM0 account.",
          code: "CONFLICT",
        },
      },
      { status: 409 },
    );
  }

  // Ensure scope and artifact exist for the user
  await ensureScopeAndArtifact(userId);

  // Create the link
  await globalThis.services.db
    .insert(slackUserLinks)
    .values({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    })
    .returning({ id: slackUserLinks.id });

  // Auto-share workspace agent with the new user
  const email = await getUserEmail(userId);
  if (email && installation.defaultComposeId) {
    await addPermission(
      installation.defaultComposeId,
      "email",
      installation.adminSlackUserId,
      email,
    ).catch((error) => {
      log.warn("Failed to auto-share workspace agent", { error });
    });
  }

  // Send success message to the Slack channel
  if (channelId) {
    await sendSuccessMessage(
      installation.encryptedBotToken,
      channelId,
      slackUserId,
      installation.defaultComposeId,
    ).catch((error) => {
      log.warn("Failed to send success message", { error });
    });
  }

  // Refresh App Home to show linked state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshAppHome(client, installation, slackUserId).catch((error) => {
    log.warn("Failed to refresh App Home after link", { error });
  });

  return NextResponse.json({ success: true });
}

/**
 * Send success message to the Slack channel (ephemeral - only visible to the user)
 */
async function sendSuccessMessage(
  encryptedBotToken: string,
  channelId: string,
  slackUserId: string,
  defaultComposeId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptCredentialValue(
    encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const agent = await getWorkspaceAgent(defaultComposeId);
  const agentInfo = agent
    ? `The workspace agent \`${agent.name}\` is ready to use.`
    : "";

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Successfully connected to VM0!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Successfully connected to VM0!*\n\n${agentInfo}\n\nYou can now:\n• Mention \`@VM0\` to interact with the agent\n• Use \`/vm0 settings\` to configure your secrets and variables`,
        },
      },
    ],
  });
}
