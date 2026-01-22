import type { InboundMessage, ConnectionStateChange } from "ably";
import { apiClient } from "../api/api-client";
import { createRealtimeClient, getRunChannelName } from "./client";

/**
 * Data payload for events messages (message.name === "events")
 */
interface EventsData {
  events: unknown[];
  nextSequence: number;
}

/**
 * Data payload for status messages (message.name === "status")
 */
interface StatusData {
  status: "completed" | "failed" | "timeout";
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Result from streaming events
 */
export interface StreamResult {
  succeeded: boolean;
  runId: string;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Options for streamEvents
 */
export interface StreamOptions {
  verbose?: boolean;
  startTimestamp: Date;
  onEvent: (
    event: unknown,
    options: {
      verbose?: boolean;
      previousTimestamp: Date;
      startTimestamp: Date;
    },
  ) => Date;
  onRunCompleted: (
    result: Record<string, unknown> | undefined,
    options: {
      verbose?: boolean;
      previousTimestamp: Date;
      startTimestamp: Date;
    },
  ) => void;
  onRunFailed: (error: string | undefined, runId: string) => void;
  onTimeout: (runId: string) => void;
}

/**
 * Stream events in realtime using Ably
 * This replaces polling with push-based realtime updates
 *
 * @param runId - The run ID to stream events for
 * @param options - Streaming options including event handlers
 * @returns Promise that resolves when the run completes
 * @throws Error if realtime connection fails (no fallback to polling)
 */
export async function streamEvents(
  runId: string,
  options: StreamOptions,
): Promise<StreamResult> {
  const {
    verbose,
    startTimestamp,
    onEvent,
    onRunCompleted,
    onRunFailed,
    onTimeout,
  } = options;
  let previousTimestamp = startTimestamp;

  // Create Ably client with token-based auth
  const ablyClient = createRealtimeClient(async () => {
    return apiClient.getRealtimeToken(runId);
  });

  return new Promise<StreamResult>((resolve, reject) => {
    const channelName = getRunChannelName(runId);

    // Subscribe with rewind to get messages from the last 2 minutes
    // This handles the race condition where events are published before we subscribe
    const channel = ablyClient.channels.get(channelName, {
      params: { rewind: "2m" },
    });

    let result: StreamResult = { succeeded: true, runId };
    // Sandbox sends 1-based sequence numbers (first event has sequenceNumber: 1)
    let nextExpectedSequence = 1;

    // Handle connection errors
    ablyClient.connection.on("failed", (stateChange: ConnectionStateChange) => {
      cleanup();
      reject(
        new Error(
          `Realtime connection failed: ${stateChange.reason?.message || "Unknown error"}`,
        ),
      );
    });

    function cleanup(): void {
      channel.unsubscribe();
      ablyClient.close();
    }

    function handleMessage(message: InboundMessage): void {
      if (message.name === "events") {
        const data = message.data as EventsData;
        // Process events
        for (const event of data.events) {
          const eventData = event as { sequenceNumber?: number };
          const seq = eventData.sequenceNumber;

          // Track sequence for gap detection
          if (seq !== undefined) {
            // Check for gaps (missing sequences)
            if (seq > nextExpectedSequence) {
              // Gap detected - we may have missed events
              // In fail-fast mode, we continue but log a warning
              console.warn(
                `Warning: Event sequence gap detected (expected ${nextExpectedSequence}, got ${seq})`,
              );
            }
            nextExpectedSequence = Math.max(nextExpectedSequence, seq + 1);
          }

          // Render the event
          previousTimestamp = onEvent(event, {
            verbose,
            previousTimestamp,
            startTimestamp,
          });
        }
      } else if (message.name === "status") {
        const data = message.data as StatusData;
        // Run completed/failed/timeout
        if (data.status === "completed") {
          onRunCompleted(data.result, {
            verbose,
            previousTimestamp,
            startTimestamp,
          });
          result = {
            succeeded: true,
            runId,
            sessionId: data.result?.agentSessionId as string | undefined,
            checkpointId: data.result?.checkpointId as string | undefined,
          };
        } else if (data.status === "failed") {
          onRunFailed(data.error, runId);
          result = { succeeded: false, runId };
        } else if (data.status === "timeout") {
          onTimeout(runId);
          result = { succeeded: false, runId };
        }

        // Cleanup and resolve
        cleanup();
        resolve(result);
      }
    }

    // Subscribe to the channel (returns a promise)
    channel.subscribe(handleMessage).catch((err: Error) => {
      cleanup();
      reject(
        new Error(`Failed to subscribe to realtime channel: ${err.message}`),
      );
    });
  });
}
