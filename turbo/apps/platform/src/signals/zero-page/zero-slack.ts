import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { zeroIntegrationsSlackContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { throwIfAbort } from "../utils.ts";

const slackReload$ = state(0);

const reloadSlackOrg$ = command(({ set }) => {
  set(slackReload$, (x) => x + 1);
});

export const slackOrgData$ = computed(async (get) => {
  get(slackReload$);
  const client = get(zeroClient$)(zeroIntegrationsSlackContract);
  const result = await client.getStatus();
  if (result.status !== 200) {
    throw new Error(`Failed to fetch Slack status: ${result.status}`);
  }
  return result.body;
});

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
    set(reloadSlackOrg$);
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
    set(reloadSlackOrg$);
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
    try {
      const current = await get(slackOrgData$);
      signal.throwIfAborted();
      if (current.isConnected) {
        return;
      }
    } catch (error) {
      throwIfAbort(error);
      // treat fetch error as not-connected, proceed with polling
    }

    while (!signal.aborted) {
      await delay(POLL_INTERVAL_MS, { signal });

      set(reloadSlackOrg$);
      try {
        const fresh = await get(slackOrgData$);
        signal.throwIfAborted();
        if (fresh.isConnected) {
          toast.success("Slack connected successfully");
          return;
        }
      } catch (error) {
        throwIfAbort(error);
        // ignore poll error, keep polling
      }
    }
  },
);

export const initSlackOrg$ = command((_ctx, _signal: AbortSignal) => {
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
