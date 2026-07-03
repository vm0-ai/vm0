import { command } from "ccstate";
import {
  zeroAttributionContract,
  type AdAttributionMetadata,
} from "@vm0/api-contracts/contracts/zero-attribution";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { getStoredAdAttributionMetadata } from "./ad-attribution.ts";

const SIGNUP_ATTRIBUTION_RECORDED_KEY = "vm0.signupAttributionRecorded";
const SIGNUP_CONVERSION_RECORDED_KEY = "vm0.googleAdsSignupConversionRecorded";
const GOOGLE_ADS_SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
const SIGNUP_CONVERSION_VALUE_USD = 1;
const SIGNUP_CONVERSION_MAX_USER_AGE_MS = 30 * 60 * 1000;

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

  gtag("event", "conversion", {
    send_to: GOOGLE_ADS_SIGNUP_SEND_TO,
    value: SIGNUP_CONVERSION_VALUE_USD,
    currency: "USD",
  });
  storage?.setItem(SIGNUP_CONVERSION_RECORDED_KEY, fingerprint);
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function isRecentlyCreatedUser(user: {
  readonly createdAt?: unknown;
}): boolean {
  const createdAtMs = timestampMs(user.createdAt);
  if (createdAtMs === null) {
    return false;
  }
  const ageMs = now() - createdAtMs;
  return ageMs >= 0 && ageMs <= SIGNUP_CONVERSION_MAX_USER_AGE_MS;
}

export const recordSignupAttribution$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const user = await get(user$);
    signal.throwIfAborted();
    if (!user) {
      return;
    }

    const storedAttribution = getStoredAdAttributionMetadata();
    const recentlyCreatedUser = isRecentlyCreatedUser(user);
    const attribution: AdAttributionMetadata | undefined =
      storedAttribution ??
      (recentlyCreatedUser ? { source_type: "unknown" } : undefined);
    if (!attribution) {
      return;
    }

    const storage = getSessionStorage();
    const attributionFingerprint = `${user.id}:${JSON.stringify(attribution)}`;
    let recorded =
      storage?.getItem(SIGNUP_ATTRIBUTION_RECORDED_KEY) ===
      attributionFingerprint;

    if (!recorded) {
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
      recorded = result.body.recorded;
      if (recorded) {
        storage?.setItem(
          SIGNUP_ATTRIBUTION_RECORDED_KEY,
          attributionFingerprint,
        );
      }
    }

    if (recorded && recentlyCreatedUser) {
      trackGoogleAdsSignupConversion(storage, user.id);
    }
  },
);
