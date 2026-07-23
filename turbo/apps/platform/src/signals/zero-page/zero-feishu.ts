import { command, computed, state } from "ccstate";
import {
  zeroFeishuConnectContract,
  type FeishuConnectStatus,
} from "@vm0/api-contracts/contracts/zero-feishu-connect";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { resetSignal, setLoop } from "../utils.ts";

const reload$ = state(0);
const internalDialogOpen$ = state(false);
const internalEditing$ = state(false);
const internalSetupForm$ = state<FeishuSetupInput>({
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  defaultAgentId: "",
});
const resetPollingSignal$ = resetSignal();

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
    await accept(client.disconnect({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
  },
);

export interface FeishuSetupInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly defaultAgentId: string;
}

export const feishuDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});

export const feishuEditing$ = computed((get) => {
  return get(internalEditing$);
});

export const feishuSetupForm$ = computed((get) => {
  return get(internalSetupForm$);
});

export const openFeishuDialog$ = command(
  ({ set }, initial: Pick<FeishuSetupInput, "appId" | "defaultAgentId">) => {
    set(internalDialogOpen$, true);
    set(internalSetupForm$, {
      ...initial,
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
    });
  },
);

export const closeFeishuDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
  set(internalEditing$, false);
});

export const setFeishuEditing$ = command(
  (
    { set },
    input: Pick<FeishuSetupInput, "appId" | "defaultAgentId"> | null,
  ) => {
    set(internalEditing$, input !== null);
    if (input) {
      set(internalSetupForm$, {
        ...input,
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
      });
    }
  },
);

export const updateFeishuSetupForm$ = command(
  ({ set }, update: Partial<FeishuSetupInput>) => {
    set(internalSetupForm$, (previous) => {
      return { ...previous, ...update };
    });
  },
);

export const setupFeishuOrg$ = command(
  async (
    { get, set },
    input: FeishuSetupInput,
    signal: AbortSignal,
  ): Promise<FeishuConnectStatus> => {
    const client = get(zeroClient$)(zeroFeishuConnectContract);
    const result = await accept(
      client.setup({ body: input, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);

export const removeFeishuOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroFeishuConnectContract);
    await accept(client.remove({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
  },
);

const refreshFeishuOrg$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

export const pollFeishuSetupStatus$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const pollingSignal = set(resetPollingSignal$, signal);
    await setLoop(
      async () => {
        if (!get(internalDialogOpen$)) {
          return true;
        }
        set(refreshFeishuOrg$);
        const data = await get(feishuOrgData$);
        pollingSignal.throwIfAborted();
        return !data.isInstalled || data.messageReceived;
      },
      2000,
      pollingSignal,
    );
  },
);
