import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun, isRunDispatchError } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { getOrgData } from "../../org/org-cache-service";
import { orgTierSchema } from "@vm0/core";
import { logger } from "../../logger";

const log = logger("slack-org:run-agent");

/**
 * Org-aware callback context for Slack
 */
export interface SlackOrgCallbackContext {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
  orgId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

interface RunAgentParams {
  composeId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  orgId: string;
  callbackContext: SlackOrgCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for org-aware Slack integration.
 *
 * Key difference from legacy: passes orgId, orgSlug, orgTier explicitly
 * to createRun() instead of relying on getDefaultOrg().
 */
export async function runAgentForSlackOrg(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    composeId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userId,
    orgId,
    callbackContext,
  } = params;

  try {
    // Get compose and latest version
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (!compose) {
      return {
        status: "failed",
        response: "Error: Agent configuration not found.",
        runId: undefined,
      };
    }

    // Get latest version
    let versionId = compose.headVersionId;
    if (!versionId) {
      const [latestVersion] = await globalThis.services.db
        .select({ id: agentComposeVersions.id })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.composeId, compose.id))
        .orderBy(desc(agentComposeVersions.createdAt))
        .limit(1);

      if (!latestVersion) {
        return {
          status: "failed",
          response: "Error: Agent has no versions configured.",
          runId: undefined,
        };
      }
      versionId = latestVersion.id;
    }

    // Build prompt with integration context
    const integrationContext = buildIntegrationContext("Slack");
    const fullPrompt = threadContext
      ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
      : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

    // Build callback
    const callbackUrl = `${getApiUrl()}/api/internal/callbacks/slack/org`;
    const callbackSecret = generateCallbackSecret();

    // Resolve org context for explicit passing
    const orgData = await getOrgData(orgId);
    const orgTier = orgTierSchema.parse(orgData.tier);

    // Create run with EXPLICIT org context
    const result = await createRun({
      userId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      composeId: compose.id,
      sessionId,
      agentName,
      artifactName: "artifact",
      memoryName: "memory",
      orgId,
      orgSlug: orgData.slug,
      orgTier,
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for Slack org agent ${agentName}`);

    return { status, runId: result.runId };
  } catch (error) {
    const runId = isRunDispatchError(error) ? error.runId : undefined;
    log.error("Error running agent for Slack org:", error);
    return {
      status: "failed",
      response:
        "Something went wrong while starting the agent. Please try again later.",
      runId,
    };
  }
}
