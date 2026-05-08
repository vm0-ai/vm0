import "server-only";
import { readVoiceChatItems } from "./item-service";
import { listSessionTasks } from "./task-service";
import { buildSlowBrainAppendSystemPrompt } from "./build-slow-brain-prompt";
import { resolveAgentSystemPrompt } from "./trigger-reasoning";

/**
 * Build the slow-brain `appendSystemPrompt` used when spawning a voice-chat
 * task run. Called from the user-facing `/api/zero/voice-chat/[id]/tasks`
 * route. Pulling the three reads + the builder out keeps the route a
 * single line and is a stable seam for any future caller that needs the
 * same context.
 */
export async function buildVoiceChatTaskAppendSystemPrompt(params: {
  sessionId: string;
  agentId: string;
}): Promise<string> {
  const [agentSystemPrompt, items, sessionTasks] = await Promise.all([
    resolveAgentSystemPrompt(params.agentId),
    readVoiceChatItems(params.sessionId),
    listSessionTasks(params.sessionId),
  ]);
  return buildSlowBrainAppendSystemPrompt({
    agentSystemPrompt,
    items,
    sessionTasks,
  });
}
