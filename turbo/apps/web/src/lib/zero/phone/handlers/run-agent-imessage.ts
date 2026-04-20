import { createZeroRun } from "../../zero-run-service";
import { logger } from "../../../shared/logger";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";
import { adaptImessageTrigger } from "./adapt-imessage-trigger";

const log = logger("imessage:run-agent");

interface RunAgentParams {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  fromNumber: string;
  userId: string;
  callbackContext: IMessageCallbackPayload;
  apiStartTime: number;
}

export async function runAgentForIMessage(
  params: RunAgentParams,
): Promise<void> {
  const result = await createZeroRun(adaptImessageTrigger(params));
  log.debug(`Run ${result.runId} dispatched for iMessage`);
}
