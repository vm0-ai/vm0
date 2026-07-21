import { command, computed, state } from "ccstate";
import {
  zeroFeishuConnectContract,
  type FeishuConnectStatus,
} from "@vm0/api-contracts/contracts/zero-feishu-connect";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const reload$ = state(0);

export const feishuOrgData$ = computed(
  async (get): Promise<FeishuConnectStatus> => {
    get(reload$);
    const client = get(zeroClient$)(zeroFeishuConnectContract);
    const result = await accept(client.getStatus(), [200]);
    return result.body;
  },
);

export const disconnectFeishuOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroFeishuConnectContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
  },
);
