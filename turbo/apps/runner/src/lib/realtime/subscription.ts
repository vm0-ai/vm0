import type Ably from "ably";
import type { ConnectionStateChange, InboundMessage } from "ably";
import { z } from "zod";
import { createRealtimeClient, getRunnerGroupChannelName } from "./client.js";
import { getRealtimeToken } from "../api.js";

/**
 * Job notification schema - only contains runId
 * Runner will claim the job to get full execution context
 */
const JobNotificationSchema = z.object({
  runId: z.string(),
});

type JobNotification = z.infer<typeof JobNotificationSchema>;

/**
 * Server configuration for API calls
 */
interface ServerConfig {
  url: string;
  token: string;
}

/**
 * Job subscription handle for cleanup
 */
export interface JobSubscription {
  /** Unsubscribe and close connection */
  cleanup: () => void;
  /** The underlying Ably client (for testing) */
  client: Ably.Realtime;
}

/**
 * Subscribe to job notifications for a runner group.
 *
 * @param server - Server configuration for token fetching
 * @param group - Runner group to subscribe to
 * @param onJob - Callback when a job notification is received
 * @param onConnectionChange - Optional callback for connection state changes
 * @returns JobSubscription handle for cleanup
 */
export async function subscribeToJobs(
  server: ServerConfig,
  group: string,
  onJob: (notification: JobNotification) => void,
  onConnectionChange?: (state: string, reason?: string) => void,
): Promise<JobSubscription> {
  // Create Ably client with token-based auth
  const ablyClient = createRealtimeClient(async () => {
    return getRealtimeToken(server, group);
  });

  const channelName = getRunnerGroupChannelName(group);

  // No rewind - polling fallback handles missed notifications
  const channel = ablyClient.channels.get(channelName);

  // Handle connection state changes
  if (onConnectionChange) {
    ablyClient.connection.on((stateChange: ConnectionStateChange) => {
      onConnectionChange(stateChange.current, stateChange.reason?.message);
    });
  }

  // Handle connection failures
  ablyClient.connection.on("failed", (stateChange: ConnectionStateChange) => {
    console.error(
      `Ably connection failed: ${stateChange.reason?.message || "Unknown error"}`,
    );
  });

  // Message handler
  function handleMessage(message: InboundMessage): void {
    if (message.name === "job") {
      const result = JobNotificationSchema.safeParse(message.data);
      if (result.success) {
        onJob(result.data);
      } else {
        console.error(`Invalid job notification:`, result.error.issues);
      }
    }
  }

  // Subscribe to the channel
  await channel.subscribe(handleMessage);

  console.log(`Subscribed to job notifications on ${channelName}`);

  // Return cleanup handle
  return {
    cleanup: () => {
      channel.unsubscribe();
      ablyClient.close();
      console.log(`Unsubscribed from ${channelName}`);
    },
    client: ablyClient,
  };
}
