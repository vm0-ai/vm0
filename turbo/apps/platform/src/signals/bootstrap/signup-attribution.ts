import { command } from "ccstate";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { getStoredAdAttributionMetadata } from "./ad-attribution.ts";

const SIGNUP_ATTRIBUTION_RECORDED_KEY = "vm0.signupAttributionRecorded";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

export const recordSignupAttribution$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const attribution = getStoredAdAttributionMetadata();
    if (!attribution) {
      return;
    }

    const user = await get(user$);
    signal.throwIfAborted();
    if (!user) {
      return;
    }

    const storage = getSessionStorage();
    const fingerprint = JSON.stringify(attribution);
    if (storage?.getItem(SIGNUP_ATTRIBUTION_RECORDED_KEY) === fingerprint) {
      return;
    }

    const createClient = get(zeroClient$);
    const client = createClient(zeroAttributionContract);
    await accept(
      client.recordSignup({
        body: { attribution },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    storage?.setItem(SIGNUP_ATTRIBUTION_RECORDED_KEY, fingerprint);
  },
);
