import { command, computed } from "ccstate";
import { zeroFeishuBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-browser-connect";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";

interface FeishuConnectParams {
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly ts: number;
  readonly sig: string;
}

interface FeishuConnectStatus {
  readonly botName: string | null;
  readonly openUrl: string;
}

export const hasFeishuConnectParams$ = computed((get): boolean => {
  const params = get(searchParams$);
  return params.get("connect") === "account";
});

export const feishuConnectParams$ = computed(
  (get): FeishuConnectParams | null => {
    const params = get(searchParams$);
    const installationId = params.get("installationId");
    const openId = params.get("openId");
    const chatId = params.get("chatId");
    const timestamp = Number(params.get("ts"));
    const sig = params.get("sig");

    if (
      !installationId ||
      !openId ||
      !chatId ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 ||
      !sig
    ) {
      return null;
    }

    return {
      installationId,
      openId,
      chatId,
      ts: timestamp,
      sig,
    };
  },
);

export const feishuConnectStatus$ = computed(
  async (get, { signal }): Promise<FeishuConnectStatus | null> => {
    const params = get(feishuConnectParams$);
    if (!params) {
      return null;
    }
    const client = get(zeroClient$)(zeroFeishuBrowserConnectContract);
    const [result] = await Promise.allSettled([
      accept(
        client.getStatus({
          query: params,
          fetchOptions: { signal },
        }),
        [200],
      ),
    ]);
    signal.throwIfAborted();
    if (result?.status !== "fulfilled" || !result.value.body.isConnected) {
      return null;
    }
    return {
      botName: result.value.body.botName,
      openUrl: result.value.body.openUrl,
    };
  },
);

export const connectFeishuAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(feishuConnectParams$);
    if (!params) {
      return null;
    }

    const client = get(zeroClient$)(zeroFeishuBrowserConnectContract);
    const result = await accept(
      client.connectFromApp({
        body: params,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    window.location.href = result.body.openUrl;
    return result.body;
  },
);
