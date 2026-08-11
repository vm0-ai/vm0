import { command } from "ccstate";
import {
  zeroAttributionContract,
  type AdAttributionMetadata,
} from "@vm0/api-contracts/contracts/zero-attribution";

import { accept } from "../../lib/accept.ts";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { getStoredAdAttributionMetadata } from "./ad-attribution.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_SIGNUP_SEND_TO,
} from "./google-ads-conversion.ts";

const SIGNUP_ATTRIBUTION_RECORDED_KEY = "vm0.signupAttributionRecorded";
const SIGNUP_CONVERSION_RECORDED_KEY = "vm0.googleAdsSignupConversionRecorded";
const SIGNUP_CONVERSION_VALUE_USD = 1;
const SIGNUP_CONVERSION_MAX_USER_AGE_MS = 30 * 60 * 1000;

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
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
        capturePaidOnboardingEvent("SignupAttributionRecorded", {
          landing_host: window.location.host,
          landing_path: window.location.pathname,
          source_type: attribution.source_type ?? "unknown",
          ...(attribution.vm0_campaign_id
            ? { vm0_campaign_id: attribution.vm0_campaign_id }
            : {}),
          ...(attribution.vm0_ad_group_id
            ? { vm0_ad_group_id: attribution.vm0_ad_group_id }
            : {}),
        });
      }
    }

    if (recorded && recentlyCreatedUser) {
      fireGoogleAdsConversion({
        sendTo: GOOGLE_ADS_SIGNUP_SEND_TO,
        dedupeKey: SIGNUP_CONVERSION_RECORDED_KEY,
        dedupeValue: user.id,
        value: SIGNUP_CONVERSION_VALUE_USD,
        storage,
      });
    }
  },
);
