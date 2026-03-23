import type { TriggerSource } from "@vm0/core";
import { startRun, type CreateRunResult } from "../run";
import { DISALLOWED_CRON_TOOLS } from "../integration-context";
import { buildAgentIdentityPrompt } from "../agent-identity";
import type { CallbackPayload } from "../callback/callback-payloads";

/**
 * Parameters accepted by createZeroRun().
 * All zero trigger paths (web, schedule, telegram, slack, email, github)
 * use this interface to create agent runs with consistent defaults.
 */
interface ZeroRunParams {
  userId: string;
  prompt: string;
  composeId: string;
  triggerSource: TriggerSource;
  sessionId?: string;
  appendSystemPrompt?: string;
  modelProvider?: string;
  callbacks?: Array<{ url: string; secret: string; payload: CallbackPayload }>;
  scheduleId?: string;
}

/**
 * Create an agent run with zero-layer defaults.
 *
 * Injects agent identity, memoryName, artifactName, and disallowedTools
 * so that every zero trigger path gets consistent identity, memory
 * persistence, artifact storage, and cron-tool restrictions.
 */
export async function createZeroRun(
  params: ZeroRunParams,
): Promise<CreateRunResult> {
  // Inject agent identity into appendSystemPrompt
  let { appendSystemPrompt } = params;
  if (params.composeId) {
    const identity = await buildAgentIdentityPrompt(params.composeId);
    if (identity) {
      appendSystemPrompt = appendSystemPrompt
        ? `${identity}\n\n${appendSystemPrompt}`
        : identity;
    }
  }

  return startRun({
    userId: params.userId,
    prompt: params.prompt,
    composeId: params.composeId,
    triggerSource: params.triggerSource,
    sessionId: params.sessionId,
    appendSystemPrompt,
    modelProvider: params.modelProvider,
    callbacks: params.callbacks,
    scheduleId: params.scheduleId,
    memoryName: "memory",
    artifactName: "artifact",
    disallowedTools: [...DISALLOWED_CRON_TOOLS],
  });
}
