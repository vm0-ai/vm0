/**
 * Shared type guard for agent_runs.result.agentSessionId access.
 *
 * Callers that read `agent_runs.result` as `unknown` (Drizzle JSONB typing)
 * need this guard before drilling into `result.agentSessionId` — used by
 * chat-thread session-continue lookup and voice-chat session-continue lookup.
 */
export function hasAgentSessionId(
  value: unknown,
): value is { agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { agentSessionId: unknown }).agentSessionId === "string"
  );
}
