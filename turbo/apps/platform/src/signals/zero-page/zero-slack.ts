import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";

interface SlackOrgData {
  isConnected: boolean;
  isInstalled?: boolean;
  workspaceName: string | null;
  isAdmin: boolean;
  installUrl?: string | null;
  connectUrl?: string | null;
  defaultAgentId: string | null;
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

// ---------------------------------------------------------------------------
// Uninstall dialog visibility — view-local state managed in signals layer
// ---------------------------------------------------------------------------

const showUninstallDialogState$ = state(false);

/** Whether the uninstall confirmation dialog is visible. */
export const showUninstallDialog$ = computed((get) =>
  get(showUninstallDialogState$),
);

/** Show or hide the uninstall confirmation dialog. */
export const setShowUninstallDialog$ = command(({ set }, show: boolean) => {
  set(showUninstallDialogState$, show);
});

const fetchSlackOrg$ = command(async ({ get, set }) => {
  set(slackOrgState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/zero/integrations/slack");

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

export const disconnectSlackOrg$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/zero/integrations/slack", {
    method: "DELETE",
  });

  if (!response.ok) {
    toast.error("Failed to disconnect Slack");
    return;
  }

  toast.success("Disconnected from Slack");
  await set(fetchSlackOrg$);
});

export const uninstallSlackOrg$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn(
    "/api/zero/integrations/slack?action=uninstall",
    { method: "DELETE" },
  );

  if (!response.ok) {
    toast.error("Failed to uninstall Slack");
    return;
  }

  toast.success("Slack workspace uninstalled");
  await set(fetchSlackOrg$);
});

const POLL_INTERVAL_MS = 3000;

/**
 * Poll Slack connection status until connected or aborted.
 * Used on the works page so that after the user completes OAuth in another tab
 * the UI updates automatically without a manual refresh.
 */
export const pollSlackConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Already connected — nothing to poll.
    const current = get(slackOrgState$).data;
    if (current?.isConnected) {
      return;
    }

    while (!signal.aborted) {
      await delay(POLL_INTERVAL_MS, { signal });

      const fetchFn = get(fetch$);
      const res = await fetchFn("/api/zero/integrations/slack", { signal });
      if (!res.ok) {
        continue;
      }

      const data = (await res.json()) as SlackOrgData;
      set(slackOrgState$, { data, loading: false, error: null });

      if (data.isConnected) {
        toast.success("Slack connected successfully");
        return;
      }
    }
  },
);

export const initSlackOrg$ = command(async ({ set }) => {
  await set(fetchSlackOrg$);

  const params = new URLSearchParams(window.location.search);
  if (params.get("installed") === "1") {
    toast.success("Slack installed successfully");
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("connected") === "1") {
    toast.success("Slack connected successfully");
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("error")) {
    toast.error(params.get("error")!);
    window.history.replaceState({}, "", window.location.pathname);
  }
});
