import { command, computed } from "ccstate";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

export type TeamsConnectPageStatus = "idle" | "success";

interface TeamsConnectPageState {
  readonly status: TeamsConnectPageStatus;
  readonly botName: string | null;
}

export const TEAMS_CLIENT_URL = "msteams://teams.microsoft.com/";

export function openTeamsClient(): void {
  window.open(TEAMS_CLIENT_URL, "_self");
}

const teamsConnectPageState$ = computed(
  async (get): Promise<TeamsConnectPageState> => {
    const params = get(searchParams$);
    const initialStatus = params.get("status");
    const initialError = params.get("error");
    const initialBotName = params.get("botName");

    if (initialStatus === "connected") {
      return { status: "success", botName: initialBotName };
    }

    if (initialError) {
      return { status: "idle", botName: initialBotName };
    }

    const client = get(apiClient$)(teamsConnectContract);
    const [result] = await Promise.allSettled([
      accept(client.getStatus(), [200]),
    ]);

    if (result.status !== "fulfilled") {
      return { status: "idle", botName: initialBotName };
    }
    return {
      status: result.value.body.isConnected ? "success" : "idle",
      botName: result.value.body.botName ?? initialBotName,
    };
  },
);

export const teamsConnectStatus$ = computed(async (get) => {
  return (await get(teamsConnectPageState$)).status;
});

export const teamsConnectBotName$ = computed(async (get) => {
  return (await get(teamsConnectPageState$)).botName;
});

export const effectiveTeamsError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

function teamsParam(
  params: URLSearchParams,
  primary: string,
  fallback?: string,
): string | null {
  return params.get(primary) ?? (fallback ? params.get(fallback) : null);
}

export const initTeamsConnectPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const initialStatus = params.get("status");
    const status = await get(teamsConnectStatus$);
    signal.throwIfAborted();
    if (initialStatus === "connected" && status === "success") {
      openTeamsClient();
    }
  },
);

export const connectTeamsAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const tenantId = params.get("tenantId");
    const teamsUserId = params.get("teamsUserId");
    const teamsAadObjectId = params.get("teamsAadObjectId");
    if (!tenantId || (!teamsUserId && !teamsAadObjectId)) {
      return;
    }

    const client = get(apiClient$)(teamsConnectContract);
    const displayName = teamsParam(
      params,
      "teamsUserDisplayName",
      "displayName",
    );
    const upn = teamsParam(params, "teamsUserPrincipalName", "upn");
    const tenantName = params.get("tenantName");
    const teamId = params.get("teamId");
    const teamName = params.get("teamName");
    const serviceUrl = params.get("serviceUrl");
    const conversationId = params.get("conversationId");
    const conversationType = params.get("conversationType");
    const activityId = params.get("activityId");
    const channelId = params.get("channelId");
    const threadId = params.get("threadId");

    await accept(
      client.connect({
        body: {
          tenantId,
          ...(tenantName ? { tenantName } : {}),
          ...(teamsUserId ? { teamsUserId } : {}),
          ...(teamsAadObjectId ? { teamsAadObjectId } : {}),
          ...(displayName ? { teamsUserDisplayName: displayName } : {}),
          ...(upn ? { teamsUserPrincipalName: upn } : {}),
          ...(teamId ? { teamId } : {}),
          ...(teamName ? { teamName } : {}),
          ...(serviceUrl ? { serviceUrl } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(conversationType ? { conversationType } : {}),
          ...(activityId ? { activityId } : {}),
          ...(channelId ? { channelId } : {}),
          ...(threadId ? { threadId } : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    const nextParams = new URLSearchParams(params);
    nextParams.set("status", "connected");
    nextParams.delete("error");
    set(replaceSearchParams$, nextParams);
    openTeamsClient();
  },
);
