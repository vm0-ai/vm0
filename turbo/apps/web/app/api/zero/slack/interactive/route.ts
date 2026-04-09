import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../../src/lib/zero/slack/verify";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { createSlackClient } from "../../../../../src/lib/zero/slack/client";
import { refreshOrgAppHome } from "../../../../../src/lib/zero/slack-org/handlers/app-home";
import { disconnect } from "../../../../../src/lib/zero/slack-org/connect-service";

interface SlackInteractivePayload {
  type: "view_submission" | "block_actions" | "shortcut";
  user: {
    id: string;
    username: string;
    team_id: string;
  };
  team: {
    id: string;
    domain: string;
  };
  channel?: {
    id: string;
  };
  message?: {
    ts: string;
  };
  trigger_id?: string;
  actions?: Array<{
    action_id: string;
    block_id: string;
    value?: string;
    selected_option?: { value: string };
    selected_options?: Array<{ value: string }>;
  }>;
}

/**
 * POST /api/zero/slack/interactive
 *
 * Org-aware interactive component handler.
 */
export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing Slack signature headers" },
      { status: 401 },
    );
  }

  const isValid = verifySlackSignature(
    SLACK_SIGNING_SECRET,
    headers.signature,
    headers.timestamp,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");

  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  let payload: SlackInteractivePayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractivePayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  initServices();

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) {
      return new Response("", { status: 200 });
    }

    if (action.action_id === "home_disconnect") {
      await handleHomeDisconnect(payload);
    }
  }

  return new Response("", { status: 200 });
}

/**
 * Handle disconnect button click from App Home.
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, payload.user.id),
        eq(slackOrgConnections.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!connection) {
    return;
  }

  await disconnect({
    connectionId: connection.id,
    userId: connection.vm0UserId,
  });

  // Refresh App Home to show disconnected state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.team.id))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshOrgAppHome(client, installation, payload.user.id);
}
