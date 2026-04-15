import { createZeroRun } from "../../zero-run-service";
import { buildIMessagePrompt } from "../../integration-prompt";
import { logger } from "../../../shared/logger";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";

const log = logger("imessage:run-agent");

interface RunAgentParams {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  fromNumber: string;
  userId: string;
  callbackContext: IMessageCallbackPayload;
}

/**
 * Execute an agent run for an iMessage conversation.
 * Creates a run, registers a callback, and returns immediately.
 */
export async function runAgentForIMessage(
  params: RunAgentParams,
): Promise<void> {
  const { agentId, sessionId, prompt, fromNumber, userId, callbackContext } =
    params;

  const appendSystemPrompt = buildIMessagePrompt(fromNumber) || undefined;

  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/imessage`;
  const callbackSecret = generateCallbackSecret();

  const result = await createZeroRun({
    userId,
    agentId,
    prompt,
    appendSystemPrompt,
    sessionId,
    triggerSource: "imessage",
    callbacks: [
      {
        url: callbackUrl,
        secret: callbackSecret,
        payload: callbackContext,
      },
    ],
  });

  log.debug(`Run ${result.runId} dispatched for iMessage`);
}
