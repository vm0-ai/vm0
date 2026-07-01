import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroTeamsConnectContract,
  type TeamsConnectStatus,
} from "@vm0/api-contracts/contracts/zero-teams-connect";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

const internalReload$ = state(0);
const internalTeamsStatus$ = state<TeamsConnectStatus | null>(null);

export const teamsOrgData$ = computed(async (get) => {
  get(internalReload$);
  const client = get(zeroClient$)(zeroTeamsConnectContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

const reloadTeamsOrg$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasTeamsStatusChanged(
  previous: TeamsConnectStatus | null,
  next: TeamsConnectStatus,
): previous is TeamsConnectStatus {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastTeamsStatusChange(
  previous: TeamsConnectStatus,
  next: TeamsConnectStatus,
): void {
  if (next.isConnected && !previous.isConnected) {
    toast.success("Microsoft Teams connected successfully");
    return;
  }
  if (next.isInstalled && !previous.isInstalled) {
    toast.success("Microsoft Teams installed successfully");
    return;
  }
  if (!next.isInstalled && previous.isInstalled) {
    toast.success("Microsoft Teams integration uninstalled");
    return;
  }
  if (!next.isConnected && previous.isConnected) {
    toast.success("Disconnected from Microsoft Teams");
    return;
  }
  toast.success("Microsoft Teams updated");
}

const showTeamsUninstallDialogState$ = state(false);

export const showTeamsUninstallDialog$ = computed((get) => {
  return get(showTeamsUninstallDialogState$);
});

export const setShowTeamsUninstallDialog$ = command(
  ({ set }, show: boolean) => {
    set(showTeamsUninstallDialogState$, show);
  },
);

export const disconnectTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroTeamsConnectContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    set(reloadTeamsOrg$);
  },
);

export const uninstallTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroTeamsConnectContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
    set(reloadTeamsOrg$);
  },
);

export const watchTeamsConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = await get(teamsOrgData$);
    signal.throwIfAborted();
    set(internalTeamsStatus$, current);

    const onTeamsChanged$ = command(async ({ get, set }, sig: AbortSignal) => {
      const previous = get(internalTeamsStatus$);
      set(reloadTeamsOrg$);
      const next = await get(teamsOrgData$);
      sig.throwIfAborted();
      set(internalTeamsStatus$, next);

      if (hasTeamsStatusChanged(previous, next)) {
        toastTeamsStatusChange(previous, next);
      }

      return false;
    });

    await set(setAblyLoop$, "teams:changed", onTeamsChanged$, signal);
  },
);
