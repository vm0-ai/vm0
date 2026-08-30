import { computed } from "ccstate";

import { foregroundReady$ } from "../auth-retry.ts";
import { connectionDiagnostics$ } from "../connection-diagnostics.ts";
import { realtimeSubscriptionSnapshot$ } from "../realtime.ts";
import { sharedDatabaseConnectionStatus$ } from "../shared-database.ts";
import { sharedDatabaseModeEnabled$ } from "../shared-database-mode.ts";

export type OkouDebugRealtimeIndicator = "disconnected" | "reconnecting" | null;

export const okouDebugRealtimeIndicator$ = computed(
  (get): OkouDebugRealtimeIndicator => {
    const diagnostics = get(connectionDiagnostics$);
    if (!diagnostics.enabled) {
      return null;
    }

    const { online, visibilityState } = diagnostics.snapshot;
    if (!online) {
      return "disconnected";
    }
    if (get(sharedDatabaseModeEnabled$)) {
      const status = get(sharedDatabaseConnectionStatus$);
      if (status === "connected") {
        return null;
      }
      return status === "connecting" ? "reconnecting" : "disconnected";
    }
    if (visibilityState !== "visible") {
      return "disconnected";
    }

    const { channelState, connectionState } = get(
      realtimeSubscriptionSnapshot$,
    );
    if (connectionState === null && channelState === null) {
      return null;
    }
    // An initialized channel has no active subscriptions yet, so there is no
    // subscription failure to report.
    if (
      connectionState === "connected" &&
      (channelState === "attached" || channelState === "initialized")
    ) {
      return null;
    }
    if (
      connectionState === "closed" ||
      connectionState === "closing" ||
      connectionState === "failed" ||
      channelState === "failed"
    ) {
      return get(foregroundReady$).pending ? "reconnecting" : "disconnected";
    }
    return "reconnecting";
  },
);
