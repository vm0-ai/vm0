import { command, computed, state } from "ccstate";
import { searchParams$ } from "../route.ts";
import { zeroSlackConnectContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

// Internal state
const internalStatus$ = state<
  "idle" | "checking" | "connecting" | "success" | "error"
>("idle");
const internalErrorMsg$ = state("");

// Exported reads
export const slackConnectStatus$ = computed((get) => {
  return get(internalStatus$);
});

// Derived state combining URL params and signals
export const effectiveStatus$ = computed((get) => {
  const params = get(searchParams$);
  const initialStatus = params.get("status");
  const initialError = params.get("error");
  const status = get(internalStatus$);
  return initialStatus === "connected"
    ? "success"
    : initialError
      ? "error"
      : status;
});

export const effectiveError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? get(internalErrorMsg$);
});

// Reset state (called from setupSlackConnectPage$)
export const resetSlackConnectState$ = command(({ set }) => {
  set(internalStatus$, "idle");
  set(internalErrorMsg$, "");
});

// Init: check connection on page load
export const initSlackConnectPage$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const initialStatus = params.get("status");
    const initialError = params.get("error");

    if (!initialStatus && !initialError && workspaceId) {
      set(internalStatus$, "checking");
      const client = get(zeroClient$)(zeroSlackConnectContract);
      const result = await client.getStatus();
      if (result.status === 200 && result.body.isConnected) {
        set(internalStatus$, "success");
        return;
      }
      set(internalStatus$, "idle");
    }

    if (initialStatus === "connected") {
      window.location.href = "slack://open";
    }
  },
);

// Connect account
export const connectSlackAccount$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    if (!workspaceId || !slackUserId) {
      return;
    }

    set(internalStatus$, "connecting");
    const client = get(zeroClient$)(zeroSlackConnectContract);
    const channelId = params.get("c");
    const threadTs = params.get("t");
    const result = await client.connect({
      body: {
        workspaceId,
        slackUserId,
        ...(channelId ? { channelId } : {}),
        ...(threadTs ? { threadTs } : {}),
      },
    });

    if (result.status === 200) {
      set(internalStatus$, "success");
      window.location.href = "slack://open";
    } else {
      const msg =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : "Failed to connect. Please try again.";
      set(internalErrorMsg$, msg);
      set(internalStatus$, "error");
    }
  },
);
