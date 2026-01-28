import Ably from "ably";
import type { TokenRequest as AblyTokenRequest, ErrorInfo } from "ably";

/**
 * Create an Ably Realtime client with token-based authentication.
 *
 * @param getToken - Function that fetches an Ably token from the server
 * @returns Configured Ably Realtime client
 */
export function createRealtimeClient(
  getToken: () => Promise<AblyTokenRequest>,
): Ably.Realtime {
  return new Ably.Realtime({
    authCallback: (_tokenParams, callback) => {
      getToken()
        .then((tokenRequest) => {
          callback(null, tokenRequest);
        })
        .catch((error: unknown) => {
          const errorInfo: ErrorInfo = {
            name: "AuthError",
            message:
              error instanceof Error ? error.message : "Token fetch failed",
            code: 40100,
            statusCode: 401,
          };
          callback(errorInfo, null);
        });
    },
  });
}

/**
 * Get channel name for a runner group
 */
export function getRunnerGroupChannelName(group: string): string {
  return `runner-group:${group}`;
}
