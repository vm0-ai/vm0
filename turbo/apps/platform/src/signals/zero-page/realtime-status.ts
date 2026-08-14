import { computed } from "ccstate";

import { foregroundReady$ } from "../auth-retry.ts";
import { connectionDiagnostics$ } from "../connection-diagnostics.ts";
import { realtimeSubscriptionSnapshot$ } from "../realtime.ts";

export type ZeroDebugRealtimeIndicator = "disconnected" | "reconnecting" | null;

export const zeroDebugRealtimeIndicator$ = computed(
  (get): ZeroDebugRealtimeIndicator => {
    const diagnostics = get(connectionDiagnostics$);
    if (!diagnostics.enabled) {
      return null;
    }

    const { online, visibilityState } = diagnostics.snapshot;
    if (!online || visibilityState !== "visible") {
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
