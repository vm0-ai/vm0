/**
 * Event Poller
 * Polls filesystem for agent events when webhook mode is not available
 */

import type { AgentEvent } from "./event-handler";

export interface PollerOptions {
  filePath: string;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Poll a file for new events (JSONL format)
 * Each line is a JSON object representing an event
 */
export async function pollForEvents(
  sandbox: { filesystem: { read: (path: string) => Promise<string> } },
  options: PollerOptions,
): Promise<AgentEvent[]> {
  const { filePath, intervalMs = 500, timeoutMs = 30000 } = options;
  const events: AgentEvent[] = [];
  const startTime = Date.now();
  let lastPosition = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const content = await sandbox.filesystem.read(filePath);

      if (content.length > lastPosition) {
        // New content available
        const newContent = content.slice(lastPosition);
        const lines = newContent.trim().split("\n");

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as AgentEvent;
              events.push(event);
            } catch (error) {
              console.warn("Failed to parse event line:", line, error);
            }
          }
        }

        lastPosition = content.length;
      }

      // Check if agent is done (look for completion event)
      const hasCompletionEvent = events.some(
        (e) => e.type === "agent.completed" || e.type === "agent.failed",
      );

      if (hasCompletionEvent) {
        break;
      }
    } catch (error) {
      // File might not exist yet, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return events;
}
