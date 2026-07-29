import { command, computed, state } from "ccstate";
import { zeroBrowserAuthorizationRequestsContract } from "@vm0/api-contracts/contracts/zero-browser";

import { accept } from "../../lib/accept.ts";
import { pathParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";

const browserAuthorizationReload$ = state(0);

const browserAuthorizationRequestToken$ = computed((get) => {
  const token = get(pathParams$)?.requestToken;
  return typeof token === "string" ? token : null;
});

export const browserAuthorizationRequest$ = computed(async (get) => {
  get(browserAuthorizationReload$);
  const requestToken = get(browserAuthorizationRequestToken$);
  if (!requestToken) {
    return null;
  }
  const client = get(zeroClient$)(zeroBrowserAuthorizationRequestsContract);
  const result = await accept(client.get({ params: { requestToken } }), [200]);
  return result.body;
});

export const applyBrowserAuthorizationRequest$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const requestToken = get(browserAuthorizationRequestToken$);
    if (!requestToken) {
      throw new Error("Cloud browser authorization request token is missing");
    }
    const client = get(zeroClient$)(zeroBrowserAuthorizationRequestsContract);
    const result = await accept(
      client.apply({
        params: { requestToken },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(browserAuthorizationReload$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);
