// Google Ads website-tag conversions. The gtag base snippet lives in
// `apps/platform/index.html`; these are the event snippets for the conversion
// actions that Google Ads uses as bidding signals. `UPLOAD_CLICKS` conversion
// actions (the Data Manager imports) are uploaded server-side and are not
// fired from here.

export const GOOGLE_ADS_SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
export const GOOGLE_ADS_ONBOARDING_START_SEND_TO =
  "AW-18144854014/GVKdCLbQ9LscEP7_kcxD";
export const GOOGLE_ADS_CHECKOUT_START_SEND_TO =
  "AW-18144854014/EEovCKmuvbscEP7_kcxD";

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

/**
 * Fire a Google Ads conversion unless the caller already persisted the same
 * dedupe value. Returns whether the event fired so the caller can persist it.
 */
export function fireGoogleAdsConversion(args: {
  readonly sendTo: string;
  readonly dedupeValue: string;
  readonly value: number;
  readonly storedDedupeValue: string | null;
}): boolean {
  if (args.storedDedupeValue === args.dedupeValue) {
    return false;
  }

  const gtag =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithGoogleTag).gtag;
  if (typeof gtag !== "function") {
    return false;
  }

  gtag("event", "conversion", {
    send_to: args.sendTo,
    value: args.value,
    currency: "USD",
  });
  return true;
}
