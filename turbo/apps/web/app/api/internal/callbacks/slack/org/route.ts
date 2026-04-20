import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { decryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../../../src/db/schema/zero-run";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { findNewSessionId } from "../../../../../../src/lib/infra/session/find-new-session";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../../../../../../src/lib/zero/slack/client";
import { buildAgentResponseMessage } from "../../../../../../src/lib/zero/slack/blocks";
import { extractAllRunOutputs } from "../../../../../../src/lib/infra/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
  getWorkspaceAgent,
  resolveDefaultComposeId,
} from "../../../../../../src/lib/zero/slack-org/handlers/shared";
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

/**
 * Look up the run's selected model ID for the footer attribution.
 */
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
 * When the run came from a non-default agent, produce the `Sent via X` footer
 * text so users know which agent answered. Returns undefined for default-agent
 * replies, missing orgId, or unknown compose — keeping the existing output
 * byte-for-byte identical to today in those cases.
 */
async function resolveTriggeredByFooter(
  orgId: string | undefined,
  composeId: string | undefined,
): Promise<string | undefined> {
  if (!orgId || !composeId) return undefined;
  const orgDefaultComposeId = await resolveDefaultComposeId(orgId);
  if (composeId === orgDefaultComposeId) return undefined;
  const agent = await getWorkspaceAgent(composeId);
  if (!agent) return undefined;
  const label = agent.displayName ?? agent.name;
  return `Sent via ${label}`;
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

  const allOutputs = await extractAllRunOutputs(runId, error);

  const [runContext] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

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

  // Resolve session
  await saveOrgThreadSession(payload, runId, status);

  const triggeredBy = await resolveTriggeredByFooter(
    runContext?.orgId,
    payload.agentId,
  );

  // Post each result as a separate Slack reply (in order)
  for (let i = 0; i < allOutputs.length; i++) {
    const output = allOutputs[i]!;
    const responseText = buildResponseText(status, error, output);
    if (!responseText) continue;

    const isLast = i === allOutputs.length - 1;
    const logsUrl =
      isLast && auditLinkEnabled ? buildLogsUrl(runId) : undefined;

    await postMessage(client, payload.channelId, responseText, {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(
        responseText,
        logsUrl,
        triggeredBy,
        selectedModel,
      ),
    });
  }

  // Generate run summary (best-effort — errors handled internally)
  if (runContext?.prompt) {
    const combinedOutput = allOutputs
      .map((o) => {
        return o.result;
      })
      .filter(Boolean)
      .join("\n");
    await saveRunSummary(runId, "slack", runContext.prompt, combinedOutput);
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
