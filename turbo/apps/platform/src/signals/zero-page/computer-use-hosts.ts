import { command, computed, state } from "ccstate";
import {
  zeroComputerUseHostsContract,
  type ComputerUseHost,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForNavigation } from "../api-base.ts";
import { zeroClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRef } from "../utils.ts";

const ZERO_DESKTOP_DMG_DOWNLOAD_PATH =
  "/api/zero/desktop/updates/stable/darwin/arm64/dmg";

export const ZERO_DESKTOP_DOWNLOAD_URL = new URL(
  ZERO_DESKTOP_DMG_DOWNLOAD_PATH,
  resolveApiBaseForNavigation("api"),
).toString();

const computerUseHostsReload$ = state(0);

const reloadComputerUseHosts$ = command(({ set }) => {
  set(computerUseHostsReload$, (n) => {
    return n + 1;
  });
});

export const subscribeComputerUseHostsChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadComputerUseHosts$);
      return false;
    });
    await set(setAblyLoop$, "computerUseHostsChanged", onChanged$, signal);
  },
);

const subscribeComputerUseHostsChangedOnRef$ = command(
  async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    await set(subscribeComputerUseHostsChanged$, signal);
  },
);

export const subscribeComputerUseHostsChangedRef$ = onRef(
  subscribeComputerUseHostsChangedOnRef$,
);

interface ListedComputerUseHost extends Pick<
  ComputerUseHost,
  "id" | "displayName" | "lastSeenAt" | "status"
> {
  readonly hostName: string;
}

type SelectableComputerUseHost = Pick<ComputerUseHost, "id" | "status">;

export function selectedComputerUseHostId(
  hosts: readonly { readonly id: string }[],
  selectedHostId: string | null | undefined,
): string | null {
  if (!selectedHostId) {
    return null;
  }
  return hosts.some((host) => {
    return host.id === selectedHostId;
  })
    ? selectedHostId
    : null;
}

export function visibleComputerUseHosts<Host extends SelectableComputerUseHost>(
  hosts: readonly Host[],
  selectedHostId: string | null | undefined,
): Host[] {
  const selected = selectedComputerUseHostId(hosts, selectedHostId);
  const selectedHost = selected
    ? hosts.find((host) => {
        return host.id === selected;
      })
    : undefined;
  const onlineHosts = hosts.filter((host) => {
    return host.status === "online" && host.id !== selected;
  });
  return selectedHost ? [selectedHost, ...onlineHosts] : onlineHosts;
}

export const computerUseHosts$ = computed(
  async (get): Promise<ListedComputerUseHost[]> => {
    get(computerUseHostsReload$);

    const client = get(zeroClient$)(zeroComputerUseHostsContract);
    const result = await accept(client.list({}), [200, 403]);
    if (result.status !== 200) {
      return [];
    }

    return result.body.hosts.map((host) => {
      return {
        id: host.id,
        hostName: host.hostName ?? host.displayName,
        displayName: host.displayName,
        lastSeenAt: host.lastSeenAt,
        status: host.status,
      };
    });
  },
);
