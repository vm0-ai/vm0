import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { slackThreadSessions } from "../../../../../src/db/schema/slack-thread-session";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentRunCallbacks } from "../../../../../src/db/schema/agent-run-callback";
import {
  createSlackClient,
  postMessage,
  buildAgentResponseMessage,
} from "../../../../../src/lib/slack";
import { getRunOutput } from "../../../../../src/lib/slack/handlers/run-agent";
import { buildLogsUrl } from "../../../../../src/lib/slack/handlers/shared";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/logger";

const log = logger("callback:slack");

interface CallbackPayload {
  // Slack-specific context
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
  reactionAdded: boolean;
}

interface CallbackBody {
  runId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  payload: CallbackPayload;
}

function parsePayload(body: CallbackBody): CallbackPayload | null {
  if (!body.payload) return null;
  const p = body.payload;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.channelId !== "string" ||
    typeof p.threadTs !== "string" ||
    typeof p.messageTs !== "string" ||
    typeof p.userLinkId !== "string" ||
    typeof p.agentName !== "string" ||
    typeof p.composeId !== "string"
  ) {
    return null;
  }
  return p;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function findNewSessionId(
  userId: string,
  composeId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, composeId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Parse body first to get runId for callback lookup
  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { runId, status, error } = body;

  if (!runId) {
    return errorResponse("Missing runId", 400);
  }

  // Query callback record to get the per-callback secret
  const [callback] = await globalThis.services.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId))
    .limit(1);

  if (!callback) {
    log.warn("Callback record not found", { runId });
    return errorResponse("Callback not found", 404);
  }

  // Decrypt the per-callback secret
  const callbackSecret = decryptCredentialValue(
    callback.encryptedSecret,
    SECRETS_ENCRYPTION_KEY,
  );

  // Verify signature using the per-callback secret
  const signature = request.headers.get("X-VM0-Signature");
  const timestamp = request.headers.get("X-VM0-Timestamp");

  const verification = verifyCallbackRequest(
    rawBody,
    callbackSecret,
    signature,
    timestamp,
  );

  if (!verification.valid) {
    log.warn("Callback signature verification failed", {
      runId,
      error: verification.error,
    });
    return errorResponse(verification.error ?? "Invalid signature", 401);
  }

  const payload = parsePayload(body);

  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const {
    workspaceId,
    channelId,
    threadTs,
    messageTs,
    userLinkId,
    agentName,
    composeId,
    existingSessionId,
    reactionAdded,
  } = payload;

  log.debug("Processing Slack callback", { runId, status, channelId });

  // Get Slack installation for bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    log.error("Slack installation not found", { workspaceId });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Query Axiom for the agent's output
  const output = status === "completed" ? await getRunOutput(runId) : undefined;

  // Build response message
  const responseText =
    status === "completed"
      ? (output ?? "Task completed successfully.")
      : `Error: ${error ?? "Agent execution failed."}`;

  const logsUrl = buildLogsUrl(runId);

  // Post response to Slack
  await postMessage(client, channelId, responseText, {
    threadTs,
    blocks: buildAgentResponseMessage(responseText, agentName, logsUrl),
  });

  // Get run to find userId for session lookup
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  // Save thread session mapping
  if (run) {
    const newSessionId = !existingSessionId
      ? await findNewSessionId(run.userId, composeId, run.createdAt)
      : undefined;

    if (!existingSessionId && newSessionId) {
      // New thread — create mapping
      await globalThis.services.db
        .insert(slackThreadSessions)
        .values({
          slackUserLinkId: userLinkId,
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          agentSessionId: newSessionId,
          lastProcessedMessageTs: messageTs,
        })
        .onConflictDoNothing();
    } else if (existingSessionId && status === "completed") {
      // Existing thread, successful run — update lastProcessedMessageTs
      await globalThis.services.db
        .update(slackThreadSessions)
        .set({
          lastProcessedMessageTs: messageTs,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(slackThreadSessions.slackUserLinkId, userLinkId),
            eq(slackThreadSessions.slackChannelId, channelId),
            eq(slackThreadSessions.slackThreadTs, threadTs),
          ),
        );
    }
  }

  // Remove thinking reaction
  if (reactionAdded) {
    await client.reactions
      .remove({
        channel: channelId,
        timestamp: messageTs,
        name: "thought_balloon",
      })
      .catch((err) => {
        // Non-critical: reaction may already be removed or message deleted
        log.debug("Failed to remove thinking reaction", { runId, error: err });
      });
  }

  log.debug("Slack callback processed successfully", { runId });

  return NextResponse.json({ success: true });
}
