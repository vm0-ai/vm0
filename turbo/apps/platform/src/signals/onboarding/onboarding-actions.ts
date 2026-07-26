import { command } from "ccstate";
import { onboardingCompleteContract } from "@vm0/api-contracts/contracts/onboarding";
import {
  zeroBillingCheckoutContract,
  zeroBillingRedeemCodeContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import { zeroClient$ } from "../api-client.ts";
import { ROUTES } from "../route-paths.ts";
import { setLoop } from "../utils.ts";
import { billingStatusAsync$ } from "../zero-page/billing.ts";
import { getStoredAdAttributionMetadata } from "../bootstrap/ad-attribution.ts";
import { reloadOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { resetOnboardingDraft$ } from "./onboarding-state.ts";

export const completeOnboarding$ = command(
  async (
    { get, set },
    redeemCode: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(zeroClient$);
    if (redeemCode) {
      const redeemClient = createClient(zeroBillingRedeemCodeContract);
      await accept(
        redeemClient.create({
          body: { code: redeemCode },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
    }

    const onboardingClient = createClient(onboardingCompleteContract);
    await accept(
      onboardingClient.complete({
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadOnboardingStatus$);
    set(resetOnboardingDraft$);
  },
);

export type OnboardingVideoRunResult = "run" | "checkout";

interface OnboardingVideoCheckoutInput {
  readonly prompt: string;
  readonly note: string;
  readonly templateId: string;
  readonly templateSlug: string;
  readonly searchParams: URLSearchParams;
}

function checkoutReturnUrl(
  input: OnboardingVideoCheckoutInput,
  result: "pro" | "canceled",
): string {
  const url = new URL(ROUTES.onboardingVideoRun, window.location.origin);
  const params = new URLSearchParams(input.searchParams);
  params.set("choice", "video");
  params.set("prompt", input.prompt);
  params.set("template", input.templateId);
  params.set("onboarding_template", input.templateSlug);
  if (input.note.trim()) {
    params.set("onboarding_note", input.note);
  } else {
    params.delete("onboarding_note");
  }
  params.set("onboarding_billing", result);
  if (result === "pro") {
    params.set("onboarding_billing_session_id", "{CHECKOUT_SESSION_ID}");
  } else {
    params.delete("onboarding_billing_session_id");
  }
  url.search = params.toString();
  return url
    .toString()
    .replace(
      "onboarding_billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
      "onboarding_billing_session_id={CHECKOUT_SESSION_ID}",
    );
}

export const prepareOnboardingVideoRun$ = command(
  async (
    { get },
    input: OnboardingVideoCheckoutInput,
    signal: AbortSignal,
  ): Promise<OnboardingVideoRunResult> => {
    const billing = await get(billingStatusAsync$);
    signal.throwIfAborted();
    if (billing.tier === "pro" || billing.tier === "team") {
      return "run";
    }

    const client = get(zeroClient$)(zeroBillingCheckoutContract);
    const adAttribution = getStoredAdAttributionMetadata();
    const result = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: checkoutReturnUrl(input, "pro"),
          cancelUrl: checkoutReturnUrl(input, "canceled"),
          ...(adAttribution === undefined ? {} : { adAttribution }),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    window.location.href = result.body.url;
    return "checkout";
  },
);

const CHECKOUT_POLL_LIMIT = IN_VITEST ? 2 : 90;
const CHECKOUT_POLL_INTERVAL_MS = 1000;

export const completeOnboardingCheckoutReturn$ = command(
  async ({ get }, sessionId: string, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroBillingCheckoutContract);
    let attempts = 0;
    await setLoop(
      async (loopSignal) => {
        attempts += 1;
        const result = await accept(
          client.complete({
            body: { sessionId },
            fetchOptions: { signal: loopSignal },
          }),
          [200],
        );
        loopSignal.throwIfAborted();
        if (result.body.completed) {
          return true;
        }
        if (attempts >= CHECKOUT_POLL_LIMIT) {
          throw new Error("Checkout completion timed out");
        }
        return false;
      },
      CHECKOUT_POLL_INTERVAL_MS,
      signal,
      { retryTransientErrors: false },
    );
  },
);
