import { command, computed } from "ccstate";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

export type TeamsConnectPageStatus = "idle" | "success";

export const TEAMS_CLIENT_URL = "msteams://teams.microsoft.com/";

export function openTeamsClient(): void {
  window.open(TEAMS_CLIENT_URL, "_self");
}

export const teamsConnectStatus$ = computed(
  async (get): Promise<TeamsConnectPageStatus> => {
    const params = get(searchParams$);
    const initialStatus = params.get("status");
    const initialError = params.get("error");

    if (initialStatus === "connected") {
      return "success";
    }

    if (initialError) {
      return "idle";
    }

    const client = get(zeroClient$)(zeroTeamsConnectContract);
    const [result] = await Promise.allSettled([
      accept(client.getStatus(), [200]),
    ]);

    return result.status === "fulfilled" && result.value.body.isConnected
      ? "success"
      : "idle";
  },
);

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

    const client = get(zeroClient$)(zeroTeamsConnectContract);
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
