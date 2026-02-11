import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("SlackIntegration");

interface SlackIntegrationData {
  workspace: { id: string; name: string | null };
  agent: { id: string; name: string } | null;
  isAdmin: boolean;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

interface SlackIntegrationState {
  data: SlackIntegrationData | null;
  loading: boolean;
  error: string | null;
  notLinked: boolean;
  installUrl: string | null;
}

const slackIntegrationState$ = state<SlackIntegrationState>({
  data: null,
  loading: false,
  error: null,
  notLinked: false,
  installUrl: null,
});

export const slackIntegrationData$ = computed(
  (get) => get(slackIntegrationState$).data,
);
export const slackIntegrationLoading$ = computed(
  (get) => get(slackIntegrationState$).loading,
);
export const slackIntegrationNotLinked$ = computed(
  (get) => get(slackIntegrationState$).notLinked,
);
export const slackInstallUrl$ = computed(
  (get) => get(slackIntegrationState$).installUrl,
);

export const fetchSlackIntegration$ = command(async ({ get, set }) => {
  set(slackIntegrationState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/slack");

    if (response.status === 404) {
      const body = (await response.json()) as {
        installUrl?: string | null;
      };
      set(slackIntegrationState$, {
        data: null,
        loading: false,
        error: null,
        notLinked: true,
        installUrl: body.installUrl ?? null,
      });
      return;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Slack integration: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as SlackIntegrationData;
    set(slackIntegrationState$, {
      data,
      loading: false,
      error: null,
      notLinked: false,
      installUrl: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch Slack integration:", error);
    set(slackIntegrationState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

const slackDisconnectDialogState$ = state(false);

export const slackDisconnectDialogOpen$ = computed((get) =>
  get(slackDisconnectDialogState$),
);

export const openSlackDisconnectDialog$ = command(({ set }) => {
  set(slackDisconnectDialogState$, true);
});

export const closeSlackDisconnectDialog$ = command(({ set }) => {
  set(slackDisconnectDialogState$, false);
});

export const updateSlackDefaultAgent$ = command(
  async ({ get, set }, agentName: string) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/slack", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName }),
    });

    if (!response.ok) {
      throw new Error("Failed to update default agent");
    }

    // Re-fetch to get updated agent info and environment status
    await set(fetchSlackIntegration$);
  },
);

export const disconnectSlack$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/slack", {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("Failed to disconnect Slack");
  }

  // Re-fetch to get the updated state with install URL
  await set(fetchSlackIntegration$);
});
