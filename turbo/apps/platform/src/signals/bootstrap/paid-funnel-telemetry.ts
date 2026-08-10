// Paid-onboarding funnel telemetry. Every event carries the first-touch ad
// attribution captured on the marketing-site hop so PostHog can segment the
// funnel by campaign, and the two website-tag conversion actions that Google
// Ads bids on (`Onboarding Start`, `Checkout Start`) fire from the same call
// sites as their PostHog counterparts.

import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_CHECKOUT_START_SEND_TO,
  GOOGLE_ADS_ONBOARDING_START_SEND_TO,
} from "./google-ads-conversion.ts";
import { getStoredAdAttributionMetadata } from "./ad-attribution.ts";
import type { OnboardingRouteStep } from "../onboarding/onboarding-state.ts";

const ONBOARDING_START_CONVERSION_KEY =
  "vm0.googleAdsOnboardingStartConversionRecorded";
const CHECKOUT_START_CONVERSION_KEY =
  "vm0.googleAdsCheckoutStartConversionRecorded";
const ONBOARDING_START_CONVERSION_VALUE_USD = 1;
const CHECKOUT_START_CONVERSION_VALUE_USD = 1;

// Ordered so `step_index` / `step_count` stay comparable across the three
// template branches that share the same two-step shape.
const ONBOARDING_STEP_ORDER: readonly OnboardingRouteStep[] = [
  "make",
  "workflow-picker",
  "workflow-run",
  "presentation-template",
  "presentation-run",
  "image-template",
  "image-run",
  "video-template",
  "video-run",
];

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

type TelemetryProperties = Record<string, string | number | boolean>;

function attributionProperties(): TelemetryProperties {
  const attribution = getStoredAdAttributionMetadata();
  const properties: TelemetryProperties = {
    flow: "paid_onboarding",
    route_path: window.location.pathname,
  };
  if (!attribution) {
    return properties;
  }

  for (const [key, value] of Object.entries(attribution)) {
    if (typeof value === "string" && value) {
      properties[key] = value;
    }
  }
  return properties;
}

export function capturePaidOnboardingStepViewed(
  step: OnboardingRouteStep,
): void {
  const stepIndex = ONBOARDING_STEP_ORDER.indexOf(step);
  capturePaidOnboardingEvent("StepViewed", {
    ...attributionProperties(),
    step_key: step,
    step_index: stepIndex,
    step_count: ONBOARDING_STEP_ORDER.length,
  });

  // `Onboarding Start` counts one entry into the onboarding flow, so it is
  // deduped per session rather than fired on every step view.
  fireGoogleAdsConversion({
    sendTo: GOOGLE_ADS_ONBOARDING_START_SEND_TO,
    dedupeKey: ONBOARDING_START_CONVERSION_KEY,
    dedupeValue: GOOGLE_ADS_ONBOARDING_START_SEND_TO,
    value: ONBOARDING_START_CONVERSION_VALUE_USD,
    storage: getSessionStorage(),
  });
}

export function capturePaidOnboardingCheckoutCreated(
  checkoutSource: string,
): void {
  capturePaidOnboardingEvent("CheckoutCreated", {
    ...attributionProperties(),
    checkout_source: checkoutSource,
  });
}

export function capturePaidOnboardingRedirectToStripe(
  checkoutSource: string,
): void {
  capturePaidOnboardingEvent("RedirectToStripe", {
    ...attributionProperties(),
    checkout_source: checkoutSource,
  });

  fireGoogleAdsConversion({
    sendTo: GOOGLE_ADS_CHECKOUT_START_SEND_TO,
    dedupeKey: CHECKOUT_START_CONVERSION_KEY,
    dedupeValue: GOOGLE_ADS_CHECKOUT_START_SEND_TO,
    value: CHECKOUT_START_CONVERSION_VALUE_USD,
    storage: getSessionStorage(),
  });
}

export function capturePaidOnboardingAppHandoff(prompt: string): void {
  capturePaidOnboardingEvent("AppHandoff", {
    ...attributionProperties(),
    destination: "app",
    prompt_present: prompt.trim().length > 0,
    prompt_length: prompt.length,
  });
}
