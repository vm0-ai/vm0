import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

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
    // Re-start the Ably subscription so the card picks up when the user
    // re-connects via the OAuth tab.
    await Promise.all([
      set(reloadSlackOrg$),
      set(pollSlackConnection$, signal),
    ]);
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

/**
 * Subscribe to Slack connection changes until connected or aborted.
 * Used on the works page so that after the user completes OAuth in another
 * tab, the UI updates automatically without a manual refresh. Reconnect
 * signals are fanned out only to org admins (connect/disconnect is an
 * admin-only action).
 */
export const pollSlackConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Already connected — nothing to wait for.
    const current = await get(slackOrgData$);
    signal.throwIfAborted();
    if (current.isConnected) {
      return;
    }

    const onSlackChanged$ = command(async ({ get, set }, sig: AbortSignal) => {
      set(reloadSlackOrg$);
      const client = get(zeroClient$)(zeroIntegrationsSlackContract);
      const result = await accept(
        client.getStatus({ fetchOptions: { signal: sig } }),
        [200],
      );
      return result.body.isConnected;
    });

    await set(setAblyLoop$, "slack:changed", onSlackChanged$, signal);

    toast.success("Slack connected successfully");
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
