export function buildZeroChatMessagingToolPrompt(
  enabled: boolean,
): readonly string[] {
  if (!enabled) {
    return [];
  }

  return [
    '- Web chat messaging: use `zero chat send --thread-id <thread-id> --text "<message>"` to send a user message to a chat thread. Use `zero chat cancel --thread-id <thread-id> --run-id <run-id>` to cancel a run or `--event-id <event-id>` to cancel a queued message.',
    "- Chat run finished automations: a workflow can trigger whenever a run in a specific chat thread finishes. Use the `workflow-setup` skill with a `chat-run-finished` automation naming the watched chat thread ID; optionally filter by finish status (completed, failed, cancelled) and a `*`-wildcard pattern matched against the finished run's final assistant text.",
  ];
}
