import { command, computed, state, type Computed } from "ccstate";
import {
  chatThreadGithubPrsContract,
  type ChatThreadGithubPr,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { allConnectorTypes$ } from "../zero-page/settings/connectors.ts";
import { agentConnectorAuthorizationsReload$ } from "../zero-page/agent-connector-authorizations.ts";

const internalGithubPrTrackingOpenThreadId$ = state<string | null>(null);
const internalGithubPrTrackingReload$ = state(0);

export const githubPrTrackingOpenThreadId$ = computed((get) => {
  return get(internalGithubPrTrackingOpenThreadId$);
});

export const setGithubPrTrackingOpenThreadId$ = command(
  ({ set }, threadId: string | null) => {
    set(internalGithubPrTrackingOpenThreadId$, threadId);
  },
);

export const reloadGithubPrTracking$ = command(({ set }) => {
  set(internalGithubPrTrackingReload$, (value) => {
    return value + 1;
  });
});

function createAgentGithubPrTrackingAvailableFactory(): (
  agentId: string,
) => Computed<Promise<boolean>> {
  const cache = new Map<string, Computed<Promise<boolean>>>();
  return (agentId: string) => {
    const existing = cache.get(agentId);
    if (existing) {
      return existing;
    }

    const atom$ = computed(async (get): Promise<boolean> => {
      const allConnectors = await get(allConnectorTypes$);
      const githubConnector = allConnectors.find((connector) => {
        return connector.type === "github";
      });
      if (!githubConnector?.connected || githubConnector.needsReconnect) {
        return false;
      }

      get(agentConnectorAuthorizationsReload$);
      const client = get(zeroClient$)(zeroUserConnectorsContract);
      const result = await accept(
        client.get({ params: { id: agentId } }),
        [200],
        { toast: false },
      );
      return result.body.enabledTypes.includes("github");
    });

    cache.set(agentId, atom$);
    return atom$;
  };
}

function createChatThreadGithubPrsFactory(): (
  threadId: string,
) => Computed<Promise<readonly ChatThreadGithubPr[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly ChatThreadGithubPr[]>>
  >();
  return (threadId: string) => {
    const existing = cache.get(threadId);
    if (existing) {
      return existing;
    }

    const atom$ = computed(
      async (get): Promise<readonly ChatThreadGithubPr[]> => {
        get(internalGithubPrTrackingReload$);
        const client = get(zeroClient$)(chatThreadGithubPrsContract);
        const result = await accept(
          client.list({ params: { threadId } }),
          [200],
          { toast: false },
        );
        return result.body.prs;
      },
    );

    cache.set(threadId, atom$);
    return atom$;
  };
}

export const agentGithubPrTrackingAvailable$ =
  createAgentGithubPrTrackingAvailableFactory();

export const chatThreadGithubPrs$ = createChatThreadGithubPrsFactory();
