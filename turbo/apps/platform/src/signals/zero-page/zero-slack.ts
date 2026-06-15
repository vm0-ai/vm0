import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroIntegrationsSlackContract,
  type SlackOrgStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

const internalReload$ = state(0);
const internalSlackStatus$ = state<SlackOrgStatus | null>(null);

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

function hasSlackStatusChanged(
  previous: SlackOrgStatus | null,
  next: SlackOrgStatus,
): previous is SlackOrgStatus {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastSlackStatusChange(
  previous: SlackOrgStatus,
  next: SlackOrgStatus,
): void {
  if (next.isConnected && !previous.isConnected) {
    toast.success("Slack connected successfully");
    return;
  }
  if (next.isInstalled && !previous.isInstalled) {
    toast.success("Slack installed successfully");
    return;
  }
  if (!next.isInstalled && previous.isInstalled) {
    toast.success("Slack workspace uninstalled");
    return;
  }
  if (!next.isConnected && previous.isConnected) {
    toast.success("Disconnected from Slack");
    return;
  }
  toast.success("Slack updated");
}

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
    set(reloadSlackOrg$);
  },
);

export const uninstallSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroIntegrationsSlackContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
    set(reloadSlackOrg$);
  },
);

/**
 * Subscribe to Slack connection changes for the /works route lifetime.
 */
export const watchSlackConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = await get(slackOrgData$);
    signal.throwIfAborted();
    set(internalSlackStatus$, current);

    const onSlackChanged$ = command(async ({ get, set }, sig: AbortSignal) => {
      const previous = get(internalSlackStatus$);
      set(reloadSlackOrg$);
      const next = await get(slackOrgData$);
      sig.throwIfAborted();
      set(internalSlackStatus$, next);

      if (hasSlackStatusChanged(previous, next)) {
        toastSlackStatusChange(previous, next);
      }

      return false;
    });

    await set(setAblyLoop$, "slack:changed", onSlackChanged$, signal);
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
});
