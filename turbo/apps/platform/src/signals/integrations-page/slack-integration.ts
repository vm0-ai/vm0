import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("SlackIntegration");

interface SlackIntegrationData {
  workspace: { id: string; name: string | null };
  agent: { id: string; name: string } | null;
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
}

const slackIntegrationState$ = state<SlackIntegrationState>({
  data: null,
  loading: false,
  error: null,
  notLinked: false,
});

export const slackIntegrationData$ = computed(
  (get) => get(slackIntegrationState$).data,
);
export const slackIntegrationLoading$ = computed(
  (get) => get(slackIntegrationState$).loading,
);
export const slackIntegrationError$ = computed(
  (get) => get(slackIntegrationState$).error,
);
export const slackIntegrationNotLinked$ = computed(
  (get) => get(slackIntegrationState$).notLinked,
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
      set(slackIntegrationState$, {
        data: null,
        loading: false,
        error: null,
        notLinked: true,
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
