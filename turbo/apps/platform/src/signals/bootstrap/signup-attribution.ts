import { command } from "ccstate";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { getStoredAdAttributionMetadata } from "./ad-attribution.ts";

const SIGNUP_ATTRIBUTION_RECORDED_KEY = "vm0.signupAttributionRecorded";
const SIGNUP_CONVERSION_RECORDED_KEY = "vm0.googleAdsSignupConversionRecorded";
const GOOGLE_ADS_SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
const SIGNUP_CONVERSION_VALUE_USD = 1;

type GoogleTag = (
  command: "event",
  eventName: "conversion",
  params: {
    readonly send_to: string;
    readonly value: number;
    readonly currency: "USD";
  },
) => void;

type WindowWithGoogleTag = Window & {
  readonly gtag?: GoogleTag;
};

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

function trackGoogleAdsSignupConversion(
  storage: Storage | null,
  fingerprint: string,
): void {
  if (storage?.getItem(SIGNUP_CONVERSION_RECORDED_KEY) === fingerprint) {
    return;
  }

  const gtag =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithGoogleTag).gtag;
  if (typeof gtag !== "function") {
    return;
  }

  try {
    gtag("event", "conversion", {
      send_to: GOOGLE_ADS_SIGNUP_SEND_TO,
      value: SIGNUP_CONVERSION_VALUE_USD,
      currency: "USD",
    });
    storage?.setItem(SIGNUP_CONVERSION_RECORDED_KEY, fingerprint);
  } catch {
    // Conversion tracking should never block sign-up attribution persistence.
  }
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
    const result = await accept(
      client.recordSignup({
        body: { attribution },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (result.body.recorded) {
      trackGoogleAdsSignupConversion(storage, fingerprint);
    }
    storage?.setItem(SIGNUP_ATTRIBUTION_RECORDED_KEY, fingerprint);
  },
);
