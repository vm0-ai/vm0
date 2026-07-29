export function buildZeroChatMessagingToolPrompt(
  enabled: boolean,
): readonly string[] {
  if (!enabled) {
    return [];
  }

  return [
    '- Web chat messaging: use `zero chat send --thread-id <thread-id> --text "<message>"` to send a user message to a chat thread. Use `zero chat cancel --thread-id <thread-id> --run-id <run-id>` to cancel a run or `--event-id <event-id>` to cancel a queued message.',
  ];
}
