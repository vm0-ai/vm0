import { computed } from "ccstate";

import { connectionDiagnostics$ } from "../connection-diagnostics.ts";
import { sharedDatabaseConnectionStatus$ } from "../shared-database.ts";

export type OkouDebugRealtimeIndicator = "disconnected" | "reconnecting" | null;

export const okouDebugRealtimeIndicator$ = computed(
  (get): OkouDebugRealtimeIndicator => {
    const diagnostics = get(connectionDiagnostics$);
    if (!diagnostics.enabled) {
      return null;
    }

    const { online } = diagnostics.snapshot;
    if (!online) {
      return "disconnected";
    }
    const status = get(sharedDatabaseConnectionStatus$);
    if (status === "connected") {
      return null;
    }
    return status === "connecting" ? "reconnecting" : "disconnected";
  },
);
