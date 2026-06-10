import { computed } from "ccstate";
import {
  zeroComputerUseHostsContract,
  type ComputerUseHost,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

export const ZERO_DESKTOP_DOWNLOAD_URL =
  "https://github.com/vm0-ai/vm0/releases/tag/desktop-updates";

type OnlineComputerUseHost = Pick<
  ComputerUseHost,
  "id" | "displayName" | "lastSeenAt"
>;

export function selectedOnlineComputerUseHostId(
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

export const onlineComputerUseHosts$ = computed(
  async (get): Promise<OnlineComputerUseHost[]> => {
    const switches = get(featureSwitch$);
    if (!switches[FeatureSwitchKey.ComputerUse]) {
      return [];
    }

    const client = get(zeroClient$)(zeroComputerUseHostsContract);
    const result = await accept(client.list({}), [200, 403], {
      toast: false,
    });
    if (result.status !== 200) {
      return [];
    }

    return result.body.hosts
      .filter((host) => {
        return host.status === "online";
      })
      .map((host) => {
        return {
          id: host.id,
          displayName: host.displayName,
          lastSeenAt: host.lastSeenAt,
        };
      });
  },
);
