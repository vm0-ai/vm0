import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";
import { hasAnyModelProvider$ } from "../external/model-providers.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("SlackLink");

interface SlackLinkState {
  status: "checking" | "ready" | "linking" | "success" | "error";
  isLinked: boolean;
  workspaceName: string | null;
  error: string | null;
}

const slackLinkState$ = state<SlackLinkState>({
  status: "checking",
  isLinked: false,
  workspaceName: null,
  error: null,
});

export const slackLinkStatus$ = computed((get) => get(slackLinkState$).status);
export const slackLinkIsLinked$ = computed(
  (get) => get(slackLinkState$).isLinked,
);
export const slackLinkWorkspaceName$ = computed(
  (get) => get(slackLinkState$).workspaceName,
);
export const slackLinkError$ = computed((get) => get(slackLinkState$).error);

export const slackLinkParams$ = computed((get) => {
  const params = get(searchParams$);
  return {
    slackUserId: params.get("u"),
    workspaceId: params.get("w"),
    channelId: params.get("c"),
  };
});

export const initSlackLink$ = command(async ({ get, set }) => {
  const { slackUserId, workspaceId } = get(slackLinkParams$);

  if (!slackUserId || !workspaceId) {
    set(slackLinkState$, {
      status: "error",
      isLinked: false,
      workspaceName: null,
      error: "Invalid link. Missing required parameters.",
    });
    return;
  }

  set(slackLinkState$, {
    status: "checking",
    isLinked: false,
    workspaceName: null,
    error: null,
  });

  try {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({ slackUserId, workspaceId });
    const response = await fetchFn(
      `/api/integrations/slack/link?${params.toString()}`,
    );

    if (!response.ok) {
      throw new Error("Failed to check link status");
    }

    const data = (await response.json()) as {
      isLinked: boolean;
      workspaceName?: string | null;
    };

    set(slackLinkState$, {
      status: data.isLinked ? "ready" : "ready",
      isLinked: data.isLinked,
      workspaceName: data.workspaceName ?? null,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to check link status:", error);
    set(slackLinkState$, {
      status: "ready",
      isLinked: false,
      workspaceName: null,
      error: null,
    });
  }
});

export const performSlackLink$ = command(async ({ get, set }) => {
  const { slackUserId, workspaceId, channelId } = get(slackLinkParams$);

  if (!slackUserId || !workspaceId) {
    set(slackLinkState$, (prev) => ({
      ...prev,
      status: "error" as const,
      error: "Missing Slack user or workspace information",
    }));
    return { success: false };
  }

  set(slackLinkState$, (prev) => ({
    ...prev,
    status: "linking" as const,
    error: null,
  }));

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/slack/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slackUserId,
        workspaceId,
        channelId: channelId ?? undefined,
      }),
    });

    if (!response.ok) {
      const data = (await response.json()) as {
        error?: { message?: string };
      };
      throw new Error(data.error?.message ?? "Failed to link account");
    }

    set(slackLinkState$, (prev) => ({
      ...prev,
      status: "success" as const,
    }));

    let hasProvider = false;
    try {
      hasProvider = await get(hasAnyModelProvider$);
    } catch (error) {
      throwIfAbort(error);
    }

    return { success: true, workspaceId, channelId, hasProvider };
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to link Slack account:", error);
    set(slackLinkState$, (prev) => ({
      ...prev,
      status: "error" as const,
      error: error instanceof Error ? error.message : "Failed to link account",
    }));
    return { success: false };
  }
});
