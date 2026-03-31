import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { zeroIntegrationsSlackContract, type SlackOrgStatus } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

interface SlackOrgState {
  data: SlackOrgStatus | null;
  loading: boolean;
  error: string | null;
}

const slackOrgState$ = state<SlackOrgState>({
  data: null,
  loading: false,
  error: null,
});

export const slackOrgData$ = computed((get) => {
  return get(slackOrgState$).data;
});

/** True when the org-scoped Slack installation has outdated bot scopes (admin-only). */
export const slackOrgScopeMismatch$ = computed((get) => {
  const data = get(slackOrgState$).data;
  return data?.scopeMismatch === true;
});

// ---------------------------------------------------------------------------
// Uninstall dialog visibility — view-local state managed in signals layer
// ---------------------------------------------------------------------------

const showUninstallDialogState$ = state(false);

/** Whether the uninstall confirmation dialog is visible. */
export const showUninstallDialog$ = computed((get) => {
  return get(showUninstallDialogState$);
});

/** Show or hide the uninstall confirmation dialog. */
export const setShowUninstallDialog$ = command(({ set }, show: boolean) => {
  set(showUninstallDialogState$, show);
});

const fetchSlackOrg$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(slackOrgState$, (prev) => {
    return {
      ...prev,
      loading: true,
      error: null,
    };
  });

  const client = get(zeroClient$)(zeroIntegrationsSlackContract);
  const result = await client.getStatus();
  signal.throwIfAborted();

  if (result.status !== 200) {
    set(slackOrgState$, (prev) => {
      return {
        ...prev,
        loading: false,
        error: "Failed to fetch Slack status",
      };
    });
    return;
  }

  set(slackOrgState$, {
    data: result.body,
    loading: false,
    error: null,
  });
});

export const disconnectSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    const result = await client.disconnect();
    signal.throwIfAborted();

    if (result.status !== 200) {
      toast.error("Failed to disconnect Slack");
      return;
    }

    toast.success("Disconnected from Slack");
    await set(fetchSlackOrg$, signal);
  },
);

export const uninstallSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    const result = await client.disconnect({
      query: { action: "uninstall" },
    });
    signal.throwIfAborted();

    if (result.status !== 200) {
      toast.error("Failed to uninstall Slack");
      return;
    }

    toast.success("Slack workspace uninstalled");
    await set(fetchSlackOrg$, signal);
  },
);

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

      const client = get(zeroClient$)(zeroIntegrationsSlackContract);
      const result = await client.getStatus();
      signal.throwIfAborted();
      if (result.status !== 200) {
        continue;
      }

      set(slackOrgState$, { data: result.body, loading: false, error: null });

      if (result.body.isConnected) {
        toast.success("Slack connected successfully");
        return;
      }
    }
  },
);

export const initSlackOrg$ = command(async ({ set }, signal: AbortSignal) => {
  await set(fetchSlackOrg$, signal);

  const params = new URLSearchParams(window.location.search);
  if (params.get("updated") === "1") {
    toast.success("Permissions updated");
    window.history.replaceState({}, "", window.location.pathname);
  } else if (params.get("installed") === "1") {
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
