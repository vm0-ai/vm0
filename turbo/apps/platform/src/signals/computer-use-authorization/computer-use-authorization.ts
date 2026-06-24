import { command, computed, state } from "ccstate";
import {
  zeroComputerUseAuthorizationRequestsContract,
  type ComputerUseHost,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { accept } from "../../lib/accept.ts";
import { pathParams$ } from "../route.ts";
import { zeroClient$ } from "../api-client.ts";

const computerUseAuthorizationReload$ = state(0);

const computerUseAuthorizationRequestToken$ = computed((get) => {
  const params = get(pathParams$);
  const token = params?.requestToken;
  return typeof token === "string" ? token : null;
});

export const computerUseAuthorizationRequest$ = computed(async (get) => {
  get(computerUseAuthorizationReload$);
  const requestToken = get(computerUseAuthorizationRequestToken$);
  if (!requestToken) {
    return null;
  }

  const client = get(zeroClient$)(zeroComputerUseAuthorizationRequestsContract);
  const result = await accept(client.get({ params: { requestToken } }), [200], {
    toast: false,
  });
  return result.body;
});

export const applyComputerUseAuthorizationRequest$ = command(
  async (
    { get, set },
    host: Pick<ComputerUseHost, "id">,
    signal: AbortSignal,
  ) => {
    const requestToken = get(computerUseAuthorizationRequestToken$);
    if (!requestToken) {
      throw new Error("Computer Use authorization request token is missing");
    }

    const client = get(zeroClient$)(
      zeroComputerUseAuthorizationRequestsContract,
    );
    const result = await accept(
      client.apply({
        params: { requestToken },
        body: { computerUseHostId: host.id },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(computerUseAuthorizationReload$, (prev) => {
      return prev + 1;
    });
    return result.body;
  },
);
