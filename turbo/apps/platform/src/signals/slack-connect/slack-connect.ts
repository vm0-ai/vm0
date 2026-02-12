import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("SlackConnect");

interface SlackConnectAgent {
  id: string;
  name: string;
}

interface SlackConnectState {
  status: "checking" | "ready" | "linking" | "success" | "error";
  isLinked: boolean;
  workspaceName: string | null;
  error: string | null;
  isAdmin: boolean;
  defaultAgent: SlackConnectAgent | null;
  agents: SlackConnectAgent[];
  selectedAgentId: string | null;
}

const slackConnectState$ = state<SlackConnectState>({
  status: "checking",
  isLinked: false,
  workspaceName: null,
  error: null,
  isAdmin: false,
  defaultAgent: null,
  agents: [],
  selectedAgentId: null,
});

export const slackConnectStatus$ = computed(
  (get) => get(slackConnectState$).status,
);
export const slackConnectIsLinked$ = computed(
  (get) => get(slackConnectState$).isLinked,
);
export const slackConnectWorkspaceName$ = computed(
  (get) => get(slackConnectState$).workspaceName,
);
export const slackConnectError$ = computed(
  (get) => get(slackConnectState$).error,
);
export const slackConnectIsAdmin$ = computed(
  (get) => get(slackConnectState$).isAdmin,
);
export const slackConnectDefaultAgent$ = computed(
  (get) => get(slackConnectState$).defaultAgent,
);
export const slackConnectAgents$ = computed(
  (get) => get(slackConnectState$).agents,
);
export const slackConnectSelectedAgentId$ = computed(
  (get) => get(slackConnectState$).selectedAgentId,
);

export const setSlackConnectAgent$ = command(({ set }, agentId: string) => {
  set(slackConnectState$, (prev) => ({
    ...prev,
    selectedAgentId: agentId,
  }));
});

export const slackConnectParams$ = computed((get) => {
  const params = get(searchParams$);
  return {
    slackUserId: params.get("u"),
    workspaceId: params.get("w"),
    channelId: params.get("c"),
  };
});

export const initSlackConnect$ = command(async ({ get, set }) => {
  const { slackUserId, workspaceId } = get(slackConnectParams$);

  if (!slackUserId || !workspaceId) {
    set(slackConnectState$, {
      status: "error",
      isLinked: false,
      workspaceName: null,
      error: "Invalid link. Missing required parameters.",
      isAdmin: false,
      defaultAgent: null,
      agents: [],
      selectedAgentId: null,
    });
    return;
  }

  set(slackConnectState$, {
    status: "checking",
    isLinked: false,
    workspaceName: null,
    error: null,
    isAdmin: false,
    defaultAgent: null,
    agents: [],
    selectedAgentId: null,
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
      isAdmin?: boolean;
      defaultAgent?: { id: string; name: string } | null;
      agents?: { id: string; name: string }[];
    };

    set(slackConnectState$, {
      status: "ready",
      isLinked: data.isLinked,
      workspaceName: data.workspaceName ?? null,
      error: null,
      isAdmin: data.isAdmin ?? false,
      defaultAgent: data.defaultAgent ?? null,
      agents: data.agents ?? [],
      selectedAgentId: data.defaultAgent?.id ?? data.agents?.[0]?.id ?? null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to check link status:", error);
    set(slackConnectState$, {
      status: "error",
      isLinked: false,
      workspaceName: null,
      error: "Failed to check connection status. Please try again.",
      isAdmin: false,
      defaultAgent: null,
      agents: [],
      selectedAgentId: null,
    });
  }
});

export const performSlackConnect$ = command(async ({ get, set }) => {
  const { slackUserId, workspaceId, channelId } = get(slackConnectParams$);
  const { selectedAgentId, defaultAgent } = get(slackConnectState$);

  if (!slackUserId || !workspaceId) {
    set(slackConnectState$, (prev) => ({
      ...prev,
      status: "error" as const,
      error: "Missing Slack user or workspace information",
    }));
    return { success: false };
  }

  set(slackConnectState$, (prev) => ({
    ...prev,
    status: "linking" as const,
    error: null,
  }));

  const agentId = selectedAgentId ?? defaultAgent?.id;

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/slack/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slackUserId,
        workspaceId,
        channelId: channelId ?? undefined,
        agentId: agentId ?? undefined,
      }),
    });

    if (!response.ok) {
      const data = (await response.json()) as {
        error?: { message?: string };
      };
      throw new Error(data.error?.message ?? "Failed to link account");
    }

    set(slackConnectState$, (prev) => ({
      ...prev,
      status: "success" as const,
    }));

    return { success: true, workspaceId, channelId };
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to connect Slack account:", error);
    set(slackConnectState$, (prev) => ({
      ...prev,
      status: "ready" as const,
      error: error instanceof Error ? error.message : "Failed to link account",
    }));
    return { success: false };
  }
});
