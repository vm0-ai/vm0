import { command, computed } from "ccstate";
import { searchParams$ } from "../route.ts";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

export type SlackConnectStatus = "idle" | "success";

export const slackConnectStatus$ = computed(
  async (get, { signal }): Promise<SlackConnectStatus> => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const initialStatus = params.get("status");
    const initialError = params.get("error");

    if (initialStatus === "connected") {
      return "success";
    }

    if (initialError || !workspaceId) {
      return "idle";
    }

    const client = get(zeroClient$)(zeroSlackConnectContract);
    const [result] = await Promise.allSettled([
      accept(
        client.getStatus({
          fetchOptions: { signal },
        }),
        [200],
      ),
    ]);
    signal.throwIfAborted();

    return result?.status === "fulfilled" && result.value.body.isConnected
      ? "success"
      : "idle";
  },
);

export const effectiveError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

// Init: trigger connection status resolution and handle URL-driven redirect.
export const initSlackConnectPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const initialStatus = params.get("status");
    await get(slackConnectStatus$);
    signal.throwIfAborted();

    if (initialStatus === "connected") {
      window.location.href = "slack://open";
    }
  },
);

// Connect account
export const connectSlackAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    if (!workspaceId || !slackUserId) {
      return;
    }

    const client = get(zeroClient$)(zeroSlackConnectContract);
    const channelId = params.get("c");
    const threadTs = params.get("t");

    await accept(
      client.connect({
        body: {
          workspaceId,
          slackUserId,
          ...(channelId ? { channelId } : {}),
          ...(threadTs ? { threadTs } : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    window.location.href = "slack://open";
  },
);
