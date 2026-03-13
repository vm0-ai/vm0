import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";

interface SlackOrgData {
  isConnected: boolean;
  workspaceName: string | null;
  isAdmin: boolean;
  defaultAgentName: string | null;
  agentOrgSlug: string | null;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

interface SlackOrgState {
  data: SlackOrgData | null;
  loading: boolean;
  error: string | null;
}

const slackOrgState$ = state<SlackOrgState>({
  data: null,
  loading: false,
  error: null,
});

export const slackOrgData$ = computed((get) => get(slackOrgState$).data);
export const slackOrgLoading$ = computed((get) => get(slackOrgState$).loading);

const fetchSlackOrg$ = command(async ({ get, set }) => {
  set(slackOrgState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/slack/org");

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const errorMsg = body.error?.message ?? "Failed to fetch Slack status";
    set(slackOrgState$, (prev) => ({
      ...prev,
      loading: false,
      error: errorMsg,
    }));
    return;
  }

  const data = (await response.json()) as SlackOrgData;
  set(slackOrgState$, {
    data,
    loading: false,
    error: null,
  });
});

const slackOrgDisconnectDialogState$ = state(false);

export const slackOrgDisconnectDialogOpen$ = computed((get) =>
  get(slackOrgDisconnectDialogState$),
);

export const openSlackOrgDisconnectDialog$ = command(({ set }) => {
  set(slackOrgDisconnectDialogState$, true);
});

export const closeSlackOrgDisconnectDialog$ = command(({ set }) => {
  set(slackOrgDisconnectDialogState$, false);
});

export const disconnectSlackOrg$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/slack/org", {
    method: "DELETE",
  });

  if (!response.ok) {
    toast.error("Failed to disconnect Slack");
    return;
  }

  // Re-fetch to get updated state
  await set(fetchSlackOrg$);
});

export const initSlackOrg$ = command(async ({ set }) => {
  await set(fetchSlackOrg$);
});
