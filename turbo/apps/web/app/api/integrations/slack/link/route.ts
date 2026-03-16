import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { slackUserLinks } from "../../../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  refreshAppHome,
} from "../../../../../src/lib/slack";
import {
  ensureOrgAndArtifact,
  getWorkspaceAgent,
} from "../../../../../src/lib/slack/handlers/shared";
import { resolveOrgOrNull } from "../../../../../src/lib/org/resolve-org";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:slack:link");

const slackLinkQuerySchema = z.object({
  slackUserId: z.string().min(1),
  workspaceId: z.string().min(1),
});

const slackLinkBodySchema = z.object({
  slackUserId: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1).optional(),
  agentId: z.string().uuid().optional(),
});

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
  const queryResult = slackLinkQuerySchema.safeParse({
    slackUserId: url.searchParams.get("slackUserId"),
    workspaceId: url.searchParams.get("workspaceId"),
  });
  if (!queryResult.success) {
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
  const { slackUserId, workspaceId } = queryResult.data;

  // Look up installation (needed for both linked and non-linked responses)
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

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

  // Build agent fields when installation exists
  const agentFields = installation
    ? await buildAgentFields(
        userId,
        slackUserId,
        installation.adminSlackUserId,
        installation.defaultComposeId,
      )
    : {};

  if (existingLink) {
    return NextResponse.json({
      isLinked: true,
      workspaceName: installation?.slackWorkspaceName ?? null,
      ...agentFields,
    });
  }

  return NextResponse.json({ isLinked: false, ...agentFields });
}

/**
 * Build agent-related fields for the GET response.
 */
async function buildAgentFields(
  userId: string,
  slackUserId: string,
  adminSlackUserId: string,
  defaultComposeId: string,
): Promise<{
  isAdmin: boolean;
  defaultAgent: { id: string; name: string } | null;
  agents: Array<{ id: string; name: string }>;
}> {
  const isAdmin = slackUserId === adminSlackUserId;
  const defaultAgent = (await getWorkspaceAgent(defaultComposeId)) ?? null;

  let agents: Array<{ id: string; name: string }> = [];
  if (isAdmin) {
    const defaultOrg = await resolveOrgOrNull(userId);
    if (defaultOrg) {
      const userAgents = await globalThis.services.db
        .select({ id: agentComposes.id, name: agentComposes.name })
        .from(agentComposes)
        .where(eq(agentComposes.orgId, defaultOrg.orgId));

      // Prepend default agent, deduplicate by id
      const seen = new Set<string>();
      if (defaultAgent) {
        agents.push(defaultAgent);
        seen.add(defaultAgent.id);
      }
      for (const agent of userAgents) {
        if (!seen.has(agent.id)) {
          agents.push(agent);
          seen.add(agent.id);
        }
      }
    } else if (defaultAgent) {
      agents = [defaultAgent];
    }
  } else if (defaultAgent) {
    agents = [defaultAgent];
  }

  return { isAdmin, defaultAgent, agents };
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

  const parseResult = slackLinkBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "Missing or invalid slackUserId or workspaceId",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const { slackUserId, workspaceId, channelId, agentId } = parseResult.data;

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

  const effectiveAgentId = agentId ?? installation.defaultComposeId;

  // Admin selecting a different agent updates the workspace default
  if (
    agentId &&
    agentId !== installation.defaultComposeId &&
    slackUserId === installation.adminSlackUserId
  ) {
    // Update workspace default agent
    await globalThis.services.db
      .update(slackInstallations)
      .set({ defaultComposeId: agentId, updatedAt: new Date() })
      .where(eq(slackInstallations.id, installation.id));
  }

  if (existingLink) {
    if (existingLink.vm0UserId === userId) {
      if (channelId) {
        await sendSuccessMessage(
          installation.encryptedBotToken,
          channelId,
          slackUserId,
          effectiveAgentId,
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

  // Ensure org and artifact exist for the user
  await ensureOrgAndArtifact(userId);

  // Create the link
  await globalThis.services.db
    .insert(slackUserLinks)
    .values({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    })
    .returning({ id: slackUserLinks.id });

  // Send success message to the Slack channel
  if (channelId) {
    await sendSuccessMessage(
      installation.encryptedBotToken,
      channelId,
      slackUserId,
      effectiveAgentId,
    ).catch((error) => {
      log.warn("Failed to send success message", { error });
    });
  }

  // Refresh App Home to show linked state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  const effectiveInstallation = {
    ...installation,
    defaultComposeId: effectiveAgentId,
  };
  await refreshAppHome(client, effectiveInstallation, slackUserId).catch(
    (error) => {
      log.warn("Failed to refresh App Home after link", { error });
    },
  );

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
  const botToken = decryptSecretValue(
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
