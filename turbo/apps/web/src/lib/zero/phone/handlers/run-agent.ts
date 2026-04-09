import { createZeroRun } from "../../zero-run-service";
import { buildPhonePrompt } from "../../integration-prompt";
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

/**
 * Execute an agent run for a phone call.
 * Creates a run, registers a callback, and returns immediately.
 */
export async function runAgentForPhone(params: RunAgentParams): Promise<void> {
  const { agentId, sessionId, prompt, phoneContext, userId, callbackContext } =
    params;

  const appendSystemPrompt = buildPhonePrompt(phoneContext) || undefined;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/phone`;
  const callbackSecret = generateCallbackSecret();

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

  log.debug(`Run ${result.runId} dispatched for phone call`);
}
