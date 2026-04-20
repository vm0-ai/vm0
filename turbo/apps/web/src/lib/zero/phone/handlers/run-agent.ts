import { createZeroRun } from "../../zero-run-service";
import { logger } from "../../../shared/logger";
import type { PhoneCallbackPayload } from "../../../infra/callback/callback-payloads";
import { adaptPhoneTrigger } from "./adapt-phone-trigger";

const log = logger("phone:run-agent");

interface RunAgentParams {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  phoneContext: string;
  userId: string;
  callbackContext: PhoneCallbackPayload;
  apiStartTime: number;
}

export async function runAgentForPhone(params: RunAgentParams): Promise<void> {
  const result = await createZeroRun(adaptPhoneTrigger(params));
  log.debug(`Run ${result.runId} dispatched for phone call`);
}
