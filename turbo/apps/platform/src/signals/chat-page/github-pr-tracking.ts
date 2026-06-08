import { command, computed, state, type Computed } from "ccstate";
import { delay } from "signal-timers";
import {
  chatThreadGithubPrsContract,
  type ChatThreadGithubPr,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  allConnectorTypes$,
  connectorCurrentConnectionStatus,
} from "../zero-page/settings/connectors.ts";
import { agentConnectorAuthorizationsReload$ } from "../zero-page/agent-connector-authorizations.ts";
import { githubIntegrationData$ } from "../zero-page/zero-github.ts";
import { detach, Reason, resetSignal } from "../utils.ts";

const GITHUB_PR_TRACKING_POLL_INTERVAL_MS = 15_000;
const internalGithubPrTrackingOpenThreadId$ = state<string | null>(null);
const internalGithubPrTrackingReload$ = state(0);
const resetGithubPrTrackingPollingSignal$ = resetSignal();

export const githubPrTrackingOpenThreadId$ = computed((get) => {
  return get(internalGithubPrTrackingOpenThreadId$);
});

const reloadGithubPrTracking$ = command(({ set }) => {
  set(internalGithubPrTrackingReload$, (value) => {
    return value + 1;
  });
});

const startGithubPrTrackingPolling$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await delay(0, { signal });
    while (!signal.aborted) {
      signal.throwIfAborted();
      set(reloadGithubPrTracking$);
      await delay(GITHUB_PR_TRACKING_POLL_INTERVAL_MS, { signal });
    }
  },
);

export const setGithubPrTrackingOpenThreadId$ = command(
  ({ set }, threadId: string | null, parentSignal?: AbortSignal) => {
    set(internalGithubPrTrackingOpenThreadId$, threadId);

    if (threadId === null) {
      set(resetGithubPrTrackingPollingSignal$);
      return;
    }

    const signal = parentSignal
      ? set(resetGithubPrTrackingPollingSignal$, parentSignal)
      : set(resetGithubPrTrackingPollingSignal$);

    // eslint-disable-next-line ccstate/no-detach-in-signals -- panel polling is a background task scoped by resetGithubPrTrackingPollingSignal$
    detach(
      set(startGithubPrTrackingPolling$, signal),
      Reason.Entrance,
      "github-pr-tracking-poll",
    );
  },
);

export const githubPrTrackingLabelOptions$ = computed(
  async (get): Promise<readonly string[]> => {
    const data = await get(githubIntegrationData$);
    const labels = new Map<string, string>();
    for (const listener of data.labelListeners) {
      const trimmed = listener.labelName.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (!labels.has(key)) {
        labels.set(key, trimmed);
      }
    }
    return [...labels.values()].sort((left, right) => {
      return left.localeCompare(right);
    });
  },
);

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
      if (
        !githubConnector?.connected ||
        connectorCurrentConnectionStatus(githubConnector) ===
          "reconnect-required"
      ) {
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

function githubPrKey(pr: ChatThreadGithubPr): string {
  return `${pr.repo.toLowerCase()}#${pr.number}`;
}

function githubPrCheckEqual(
  left: ChatThreadGithubPr["checks"][number],
  right: ChatThreadGithubPr["checks"][number],
): boolean {
  return (
    left.name === right.name &&
    left.status === right.status &&
    left.conclusion === right.conclusion &&
    left.url === right.url &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt
  );
}

function githubPrEqual(
  left: ChatThreadGithubPr,
  right: ChatThreadGithubPr,
): boolean {
  return (
    left.repo === right.repo &&
    left.number === right.number &&
    left.title === right.title &&
    left.url === right.url &&
    left.state === right.state &&
    left.headSha === right.headSha &&
    left.rollup === right.rollup &&
    left.mergeStatus === right.mergeStatus &&
    left.checks.length === right.checks.length &&
    left.checks.every((check, index) => {
      const other = right.checks[index];
      return other !== undefined && githubPrCheckEqual(check, other);
    })
  );
}

function mergeGithubPrs(
  previous: readonly ChatThreadGithubPr[],
  next: readonly ChatThreadGithubPr[],
): readonly ChatThreadGithubPr[] {
  const previousByKey = new Map(
    previous.map((pr) => {
      return [githubPrKey(pr), pr] as const;
    }),
  );

  return next.map((pr) => {
    const existing = previousByKey.get(githubPrKey(pr));
    if (existing && githubPrEqual(existing, pr)) {
      return existing;
    }
    return pr;
  });
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

    let lastResolvedPrs: readonly ChatThreadGithubPr[] = [];
    const atom$ = computed(
      async (get): Promise<readonly ChatThreadGithubPr[]> => {
        get(internalGithubPrTrackingReload$);
        const client = get(zeroClient$)(chatThreadGithubPrsContract);
        const result = await accept(
          client.list({
            params: { threadId },
            fetchOptions: { cache: "no-store" },
          }),
          [200],
          { toast: false },
        );
        lastResolvedPrs = mergeGithubPrs(lastResolvedPrs, result.body.prs);
        return lastResolvedPrs;
      },
    );

    cache.set(threadId, atom$);
    return atom$;
  };
}

export const agentGithubPrTrackingAvailable$ =
  createAgentGithubPrTrackingAvailableFactory();

export const chatThreadGithubPrs$ = createChatThreadGithubPrsFactory();
