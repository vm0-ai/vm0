import { command, computed } from "ccstate";
import {
  zeroImageShareXContract,
  type ZeroImageShareXResponse,
} from "@vm0/api-contracts/contracts/zero-image-share-x";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  connectorCatalogStatusByRef$,
  reloadConnectors$,
} from "../external/connectors.ts";
import { connectConnectorOAuthAuthCode$ } from "./settings/connectors.ts";

export const xImageShareConnectorStatus$ = computed(async (get) => {
  const connectorsByRef = await get(connectorCatalogStatusByRef$);
  return connectorsByRef.get("x") ?? null;
});

export const connectXForImageShare$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      "x",
      "oauth",
      { connectorLabel: "X" },
      signal,
    );
    signal.throwIfAborted();
    if (connected) {
      set(reloadConnectors$);
    }
    return connected;
  },
);

export const postImageShareToX$ = command(
  async (
    { get },
    args: {
      readonly caption: string | undefined;
      readonly imageUrl: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroImageShareXResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroImageShareXContract);
    const result = await accept(
      client.post({
        body: {
          caption: args.caption,
          imageUrl: args.imageUrl,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    return result.body;
  },
);
