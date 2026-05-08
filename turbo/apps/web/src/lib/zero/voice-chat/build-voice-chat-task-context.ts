import "server-only";
import { readVoiceChatItems } from "./item-service";
import { listSessionTasks } from "./task-service";
import { buildSlowBrainAppendSystemPrompt } from "./build-slow-brain-prompt";
import { resolveAgentSystemPrompt } from "./trigger-reasoning";

/**
 * Build the slow-brain `appendSystemPrompt` used when spawning a voice-chat
 * task run. Two call sites need it: the user-facing
 * `/api/zero/voice-chat/[id]/tasks` route and the relay-side internal
 * `/api/internal/voice-chat/relay/[id]/tasks` route (#12141). Pulling the
 * three reads + the builder out keeps both routes a single line and prevents
 * silent drift.
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
