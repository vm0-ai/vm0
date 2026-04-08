import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { zeroIntegrationsSlackContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);

export const slackOrgData$ = computed(async (get) => {
  get(internalReload$);
  const client = get(zeroClient$)(zeroIntegrationsSlackContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

const reloadSlackOrg$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

/** True when the org-scoped Slack installation has outdated bot scopes (admin-only). */
export const slackOrgScopeMismatch$ = computed(async (get) => {
  const data = await get(slackOrgData$);
  return data.scopeMismatch === true;
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

export const disconnectSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    toast.success("Disconnected from Slack");
    set(reloadSlackOrg$);
  },
);

export const uninstallSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
    toast.success("Slack workspace uninstalled");
    set(reloadSlackOrg$);
  },
);

const slackPollIntervalMs$ = state(3000);

export const setSlackPollIntervalMs$ = command(({ set }, ms: number) => {
  set(slackPollIntervalMs$, ms);
});

/**
 * Poll Slack connection status until connected or aborted.
 * Used on the works page so that after the user completes OAuth in another tab
 * the UI updates automatically without a manual refresh.
 */
export const pollSlackConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Already connected — nothing to poll.
    const current = await get(slackOrgData$);
    signal.throwIfAborted();
    if (current.isConnected) {
      return;
    }

    while (!signal.aborted) {
      await delay(get(slackPollIntervalMs$), { signal });
      set(reloadSlackOrg$);
      const result = await get(slackOrgData$);
      signal.throwIfAborted();
      if (result.isConnected) {
        toast.success("Slack connected successfully");
        return;
      }
    }
  },
);

export const initSlackOrg$ = command((_ctx) => {
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
