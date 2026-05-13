import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { decryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { findNewSessionId } from "../../../../../../src/lib/infra/session/find-new-session";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../../../../../../src/lib/zero/slack/client";
import { buildAgentResponseMessage } from "../../../../../../src/lib/zero/slack/blocks";
import { extractRunOutput } from "../../../../../../src/lib/infra/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
  getWorkspaceAgent,
  resolveDefaultComposeId,
} from "../../../../../../src/lib/zero/slack-org/handlers/shared";
import { ensureOrgModelPolicies } from "../../../../../../src/lib/zero/model-policy/org-model-policy-service";
import { env } from "../../../../../../src/env";
import type { SlackOrgCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";
import { saveRunSummary } from "../../../../../../src/lib/zero/run-summary";
import { logger } from "../../../../../../src/lib/shared/logger";
import type { RunOutput } from "../../../../../../src/lib/infra/run/extract-run-output";

const log = logger("callback:slack-org");

function parsePayload(payload: unknown): SlackOrgCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.channelId !== "string" ||
    typeof p.threadTs !== "string" ||
    typeof p.messageTs !== "string" ||
    typeof p.connectionId !== "string" ||
    typeof p.agentId !== "string"
  ) {
    return null;
  }
  return p as unknown as SlackOrgCallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Look up the run's selected model ID. */
async function resolveSelectedModel(
  runId: string,
): Promise<string | undefined> {
  const [zeroRun] = await globalThis.services.db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return zeroRun?.selectedModel ?? undefined;
}

/**
 * Look up the Slack user mention (`<@U123>`) for the connection that
 * triggered this run. The callback payload's `connectionId` always points at
 * the user who @mentioned the agent.
 */
async function resolveReplyToMention(
  connectionId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId))
    .limit(1);
  return row?.slackUserId ? `<@${row.slackUserId}>` : undefined;
}

/**
 * Count distinct Slack users who've triggered the agent in this thread.
 *
 * Each Slack user has their own `slack_org_connections` row, and mentioning
 * the agent writes one `slack_org_thread_sessions` row keyed on
 * (connectionId, channelId, threadTs). Counting distinct connections for a
 * given (workspace, channel, thread) tells us how many humans are in the
 * conversation. Scoped to `workspaceId` in case channel IDs collide across
 * workspaces.
 *
 * The current run's session is written before this runs, so the current user
 * is already counted.
 */
async function countThreadMentioners(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<number> {
  const [row] = await globalThis.services.db
    .select({
      count: sql<number>`count(distinct ${slackOrgThreadSessions.connectionId})::int`,
    })
    .from(slackOrgThreadSessions)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgThreadSessions.connectionId, slackOrgConnections.id),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
        eq(slackOrgThreadSessions.slackChannelId, channelId),
        eq(slackOrgThreadSessions.slackThreadTs, threadTs),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Produce `Responded by <agent>` when the run came from a non-default agent,
 * so users can tell which agent answered in an org with several. Returns
 * undefined for the default agent, missing compose, or unknown compose.
 */
async function resolveRespondedByLabel(
  orgId: string,
  composeId: string,
): Promise<string | undefined> {
  const orgDefaultComposeId = await resolveDefaultComposeId(orgId);
  if (composeId === orgDefaultComposeId) return undefined;
  const agent = await getWorkspaceAgent(composeId);
  if (!agent) return undefined;
  return `Responded by ${agent.displayName ?? agent.name}`;
}

/**
 * Return the model display name for the footer. Always resolves to a label
 * so the footer always shows which model responded. Falls back to the
 * workspace default model when the run has no explicit `selectedModel`.
 */
async function resolveModel(
  orgId: string,
  selectedModel: string | undefined,
): Promise<string | undefined> {
  const policies = selectedModel
    ? undefined
    : await ensureOrgModelPolicies(orgId);
  const model =
    selectedModel ??
    policies?.find((policy) => {
      return policy.isDefault;
    })?.model;
  return model ? getModelDisplayName(model) : undefined;
}

/**
 * Assemble the agent-reply footer. Returns `undefined` when no hint applies —
 * the response renders with no footer at all. Parts joined by ` · `, ordered
 * "who responded · to whom · with which model".
 */
async function resolveFooterText(
  orgId: string,
  payload: SlackOrgCallbackPayload,
  selectedModel: string | undefined,
): Promise<string | undefined> {
  const [respondedBy, mentionerCount, modelLabel] = await Promise.all([
    resolveRespondedByLabel(orgId, payload.agentId),
    countThreadMentioners(
      payload.workspaceId,
      payload.channelId,
      payload.threadTs,
    ),
    resolveModel(orgId, selectedModel),
  ]);

  const parts: string[] = [];
  if (respondedBy) parts.push(respondedBy);
  if (mentionerCount > 1) {
    const replyTo = await resolveReplyToMention(payload.connectionId);
    if (replyTo) parts.push(`Reply to ${replyTo}`);
  }
  if (modelLabel) parts.push(modelLabel);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildResponseText(
  status: string,
  error: string | undefined,
  resultData: RunOutput,
): string {
  if (status !== "completed") {
    return `Error: ${error ?? "Agent execution failed."}`;
  }
  return resultData?.result ?? "Task completed successfully.";
}

/**
 * Save or update the org-aware thread session mapping.
 * Returns the resolved session ID.
 */
async function saveOrgThreadSession(
  payload: SlackOrgCallbackPayload,
  runId: string,
  status: string,
): Promise<string | undefined> {
  const { connectionId, channelId, threadTs, agentId, existingSessionId } =
    payload;

  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return existingSessionId;
  }

  const newSessionId = !existingSessionId
    ? await findNewSessionId(run.userId, agentId, run.createdAt)
    : undefined;

  await saveThreadSession({
    connectionId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    runStatus: status,
  });

  return newSessionId ?? existingSessionId;
}

/**
 * POST /api/internal/callbacks/slack/org
 *
 * Org-aware Slack callback handler for agent run completion.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<SlackOrgCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  log.debug("Processing org Slack callback", {
    runId,
    status,
    channelId: payload.channelId,
  });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Handle progress notifications
  if (status === "progress") {
    const [inst] = await globalThis.services.db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, payload.workspaceId))
      .limit(1);

    if (inst) {
      const token = decryptSecretValue(
        inst.encryptedBotToken,
        SECRETS_ENCRYPTION_KEY,
      );
      const slackClient = createSlackClient(token);
      // Fire-and-forget: setStatus is a UI hint; failure must not abort the 200 response
      // that acknowledges the progress notification to the dispatcher.
      setThreadStatus(
        slackClient,
        payload.channelId,
        payload.threadTs,
        "is thinking...",
      ).catch((err: unknown) => {
        log.warn("Failed to set thinking thread status", { runId, error: err });
      });
    }

    return NextResponse.json({ success: true });
  }

  // Get installation for bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.workspaceId))
    .limit(1);

  if (!installation) {
    log.error("Slack org installation not found", {
      workspaceId: payload.workspaceId,
    });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const [runContext] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const runOutput = await extractRunOutput(
    runId,
    error,
    runContext?.lastEventSequence,
  );

  const selectedModel = await resolveSelectedModel(runId);

  const overrides = await loadFeatureSwitchOverrides(
    runContext?.orgId,
    runContext?.userId,
  );
  const auditLinkEnabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: runContext?.userId,
    orgId: runContext?.orgId,
    overrides,
  });

  // Save session before computing the footer so `countThreadMentioners`
  // includes the current user.
  await saveOrgThreadSession(payload, runId, status);

  const footerText = runContext?.orgId
    ? await resolveFooterText(runContext.orgId, payload, selectedModel)
    : undefined;

  const responseText = buildResponseText(status, error, runOutput);
  if (responseText) {
    const logsUrl = auditLinkEnabled ? buildLogsUrl(runId) : undefined;
    await postMessage(client, payload.channelId, responseText, {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(responseText, logsUrl, footerText),
    });
  }

  // Generate run summary (best-effort — errors handled internally)
  if (runContext?.prompt) {
    await saveRunSummary(
      runId,
      "slack",
      runContext.prompt,
      runOutput.result ?? "",
    );
  }

  // Fire-and-forget: clearing the status is a UI hint; failure must not affect
  // the 200 response that acknowledges successful message delivery to the dispatcher.
  setThreadStatus(client, payload.channelId, payload.threadTs, "").catch(
    (err: unknown) => {
      log.warn("Failed to clear thread status", { runId, error: err });
    },
  );

  log.debug("Slack org callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
