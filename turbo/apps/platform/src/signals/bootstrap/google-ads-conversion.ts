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
 * Fire a Google Ads conversion at most once per (`dedupeKey`, `dedupeValue`)
 * pair in this session. `dedupeValue` is the identity the conversion is scoped
 * to: a user id for per-user conversions, or a constant for once-per-session
 * ones.
 */
export function fireGoogleAdsConversion(args: {
  readonly sendTo: string;
  readonly dedupeKey: string;
  readonly dedupeValue: string;
  readonly value: number;
  readonly storage: Storage | null;
}): void {
  if (args.storage?.getItem(args.dedupeKey) === args.dedupeValue) {
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
    send_to: args.sendTo,
    value: args.value,
    currency: "USD",
  });
  args.storage?.setItem(args.dedupeKey, args.dedupeValue);
}
