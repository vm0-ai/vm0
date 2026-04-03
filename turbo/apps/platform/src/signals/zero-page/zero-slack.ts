import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { zeroIntegrationsSlackContract, type SlackOrgStatus } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";

const slackOrgState$ = state<SlackOrgStatus | null>(null);

export const slackOrgData$ = computed((get) => {
  return get(slackOrgState$);
});

/** True when the org-scoped Slack installation has outdated bot scopes (admin-only). */
export const slackOrgScopeMismatch$ = computed((get) => {
  const data = get(slackOrgState$);
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
  const client = get(zeroClient$)(zeroIntegrationsSlackContract);
  try {
    const result = await accept(client.getStatus(), [200], { toast: false });
    signal.throwIfAborted();
    set(slackOrgState$, result.body);
  } catch (error) {
    throwIfAbort(error);
  }
});

export const disconnectSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    toast.success("Disconnected from Slack");
    await set(fetchSlackOrg$, signal);
  },
);

export const uninstallSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
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
    const current = get(slackOrgState$);
    if (current?.isConnected) {
      return;
    }

    while (!signal.aborted) {
      await delay(POLL_INTERVAL_MS, { signal });

      const client = get(zeroClient$)(zeroIntegrationsSlackContract);
      try {
        const result = await accept(client.getStatus(), [200], {
          toast: false,
        });
        signal.throwIfAborted();
        set(slackOrgState$, result.body);

        if (result.body.isConnected) {
          toast.success("Slack connected successfully");
          return;
        }
      } catch (error) {
        throwIfAbort(error);
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
