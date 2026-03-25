import { command, computed, state } from "ccstate";
import { searchParams$ } from "../route.ts";
import { fetch$ } from "../fetch.ts";

// Internal state
const internalStatus$ = state<
  "idle" | "checking" | "connecting" | "success" | "error"
>("idle");
const internalErrorMsg$ = state("");

// Exported reads
export const slackConnectStatus$ = computed((get) => get(internalStatus$));

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
export const initSlackConnectPage$ = command(async ({ get, set }) => {
  const params = get(searchParams$);
  const workspaceId = params.get("w");
  const initialStatus = params.get("status");
  const initialError = params.get("error");

  if (!initialStatus && !initialError && workspaceId) {
    set(internalStatus$, "checking");
    const fetchFn = await get(fetch$);
    const res = await fetchFn("/api/zero/integrations/slack/connect");
    if (res.ok) {
      const data = (await res.json()) as { isConnected?: boolean };
      if (data.isConnected) {
        set(internalStatus$, "success");
        return;
      }
    }
    set(internalStatus$, "idle");
  }

  if (initialStatus === "connected") {
    window.location.href = "slack://open";
  }
});

// Connect account
export const connectSlackAccount$ = command(async ({ get, set }) => {
  const params = get(searchParams$);
  const workspaceId = params.get("w");
  const slackUserId = params.get("u");
  if (!workspaceId || !slackUserId) {
    return;
  }

  set(internalStatus$, "connecting");
  const fetchFn = await get(fetch$);
  const channelId = params.get("c");
  const threadTs = params.get("t");
  const res = await fetchFn("/api/zero/integrations/slack/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      slackUserId,
      ...(channelId ? { channelId } : {}),
      ...(threadTs ? { threadTs } : {}),
    }),
  });

  if (res.ok) {
    set(internalStatus$, "success");
    window.location.href = "slack://open";
  } else {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    set(
      internalErrorMsg$,
      body.error?.message ?? "Failed to connect. Please try again.",
    );
    set(internalStatus$, "error");
  }
});
