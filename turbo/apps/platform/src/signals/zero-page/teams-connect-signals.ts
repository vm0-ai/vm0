import { command, computed } from "ccstate";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

export type TeamsConnectPageStatus = "idle" | "success";

export const teamsConnectStatus$ = computed(
  async (get, { signal }): Promise<TeamsConnectPageStatus> => {
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
      accept(
        client.getStatus({
          fetchOptions: { signal },
        }),
        [200],
      ),
    ]);
    signal.throwIfAborted();

    return result.status === "fulfilled" && result.value.body.isConnected
      ? "success"
      : "idle";
  },
);

export const effectiveTeamsError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

export const initTeamsConnectPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    await get(teamsConnectStatus$);
    signal.throwIfAborted();
  },
);

export const connectTeamsAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const tenantId = params.get("tenantId");
    const teamsUserId = params.get("teamsUserId");
    if (!tenantId || !teamsUserId) {
      return;
    }

    const client = get(zeroClient$)(zeroTeamsConnectContract);
    const displayName = params.get("displayName");
    const upn = params.get("upn");
    const teamId = params.get("teamId");
    const teamName = params.get("teamName");
    const serviceUrl = params.get("serviceUrl");
    const conversationId = params.get("conversationId");
    const channelId = params.get("channelId");
    const threadId = params.get("threadId");

    await accept(
      client.connect({
        body: {
          tenantId,
          teamsUserId,
          ...(displayName ? { teamsUserDisplayName: displayName } : {}),
          ...(upn ? { teamsUserPrincipalName: upn } : {}),
          ...(teamId ? { teamId } : {}),
          ...(teamName ? { teamName } : {}),
          ...(serviceUrl ? { serviceUrl } : {}),
          ...(conversationId ? { conversationId } : {}),
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
  },
);
