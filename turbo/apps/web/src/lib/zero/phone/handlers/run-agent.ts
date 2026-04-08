import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { buildIntegrationContext } from "../../integration-context";
import { isApiError } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { PhoneCallbackPayload } from "../../../infra/callback/callback-payloads";

const log = logger("phone:run-agent");

interface RunAgentParams {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  phoneContext: string;
  userId: string;
  callbackContext: PhoneCallbackPayload;
}

interface RunAgentResult {
  status: "dispatched" | "queued" | "failed";
  runId: string | undefined;
}

/**
 * Execute an agent run for a phone call.
 * Creates a run, registers a callback, and returns immediately.
 */
export async function runAgentForPhone(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const { agentId, sessionId, prompt, phoneContext, userId, callbackContext } =
    params;

  const contextParts = [
    buildIntegrationContext("Phone", { channelType: "dm" }),
    phoneContext,
  ].filter(Boolean);
  const appendSystemPrompt =
    contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/phone`;
  const callbackSecret = generateCallbackSecret();

  try {
    const result = await createZeroRun({
      userId,
      agentId,
      prompt,
      appendSystemPrompt,
      sessionId,
      triggerSource: "phone",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    const status = result.status === "queued" ? "queued" : "dispatched";
    log.debug(`Run ${result.runId} ${status} for phone call`);

    return { status, runId: result.runId };
  } catch (error) {
    if (isApiError(error)) {
      log.warn(`Pre-run check failed: ${error.code}`, { agentId, userId });
      return { status: "failed", runId: undefined };
    }
    const runId = isRunDispatchError(error) ? error.runId : undefined;
    log.error("Failed to create phone run", { agentId, userId, error });
    return { status: "failed", runId };
  }
}
