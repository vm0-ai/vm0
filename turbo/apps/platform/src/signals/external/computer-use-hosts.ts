import { command, computed, state } from "ccstate";
import { desktopProductFromClientHeader } from "@okouai/api-contracts/contracts/client-headers";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";

import type { ListedComputerUseHost } from "../../shared-database/computed-key.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const computerUseHostsReload$ = state(0);

export const reloadComputerUseHosts$ = command(({ set }): void => {
  set(computerUseHostsReload$, (n) => {
    return n + 1;
  });
});

export const computerUseHosts$ = computed(
  async (get): Promise<ListedComputerUseHost[]> => {
    get(computerUseHostsReload$);

    const client = get(apiClient$)(computerUseHostsContract);
    const result = await accept(client.list({}), [200, 403]);
    if (result.status !== 200) {
      return [];
    }

    return result.body.hosts.map((host) => {
      return {
        id: host.id,
        product: desktopProductFromClientHeader(host.product),
        hostName: host.hostName ?? host.displayName,
        displayName: host.displayName,
        lastSeenAt: host.lastSeenAt,
        status: host.status,
      };
    });
  },
);
