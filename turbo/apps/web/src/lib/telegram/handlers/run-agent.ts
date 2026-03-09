import { eq, desc } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { createRun, isRunDispatchError } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { isConcurrentRunLimit } from "../../errors";
import { logger } from "../../logger";
import { generateCallbackSecret, getApiUrl } from "../../callback";

const log = logger("telegram:run-agent");

/**
 * Telegram-specific context to include in the callback payload
 */
export interface TelegramCallbackContext {
  installationId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string | null;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId: string | null;
}

interface RunAgentParams {
  composeId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: TelegramCallbackContext;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

/**
 * Execute an agent run for Telegram
 *
 * Creates a run, registers a callback, and returns immediately.
 * The callback will be invoked when the run completes.
 */
export async function runAgentForTelegram(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const {
    composeId,
    agentName,
    sessionId,
    prompt,
    threadContext,
    userId,
    callbackContext,
  } = params;

  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      scopeId: agentComposes.scopeId,
      scopeSlug: scopes.slug,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .innerJoin(scopes, eq(agentComposes.scopeId, scopes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    log.error("Agent compose not found", { composeId, agentName });
    return {
      status: "failed",
      response:
        "The agent configuration could not be found. Please contact the workspace admin.",
      runId: undefined,
    };
  }

  let versionId = compose.headVersionId;
  if (!versionId) {
    const [latestVersion] = await globalThis.services.db
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, compose.id))
      .orderBy(desc(agentComposeVersions.createdAt))
      .limit(1);

    if (!latestVersion) {
      log.error("Agent has no published versions", { composeId, agentName });
      return {
        status: "failed",
        response:
          "The agent has no published versions. Please publish a version in the dashboard first.",
        runId: undefined,
      };
    }
    versionId = latestVersion.id;
  }

  const integrationContext = buildIntegrationContext("Telegram");
  const fullPrompt = threadContext
    ? `${integrationContext}\n\n${threadContext}\n\n# User Prompt\n\n${prompt}`
    : `${integrationContext}\n\n# User Prompt\n\n${prompt}`;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/telegram`;
  const callbackSecret = generateCallbackSecret();

  try {
    const result = await createRun({
      userId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      composeId: compose.id,
      sessionId,
      agentName,
      artifactName: "artifact",
      memoryName: "memory",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
      scopeId: compose.scopeId,
      scopeSlug: compose.scopeSlug,
    });

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for Telegram agent ${agentName}`);

    return {
      status,
      runId: result.runId,
    };
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      log.warn("Concurrent run limit reached", {
        composeId,
        agentName,
        userId,
      });
      return {
        status: "failed",
        response:
          "You have too many concurrent runs. Please wait for existing runs to complete.",
        runId: undefined,
      };
    }
    const runId = isRunDispatchError(error) ? error.runId : undefined;
    log.error("Failed to create run", { composeId, agentName, userId, error });
    return {
      status: "failed",
      response:
        "Something went wrong while starting the agent. Please try again later.",
      runId,
    };
  }
}
