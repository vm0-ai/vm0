import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  zeroBillingDowngradeContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  applyStoredAdAttribution,
  getStoredAdAttributionMetadata,
} from "../bootstrap/ad-attribution.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingTier = "free" | "pro-suspend" | "pro" | "team";
type CompletedBillingCheckoutTier = "pro" | "team";
export type CreditCheckoutSelection =
  | { readonly credits: number; readonly customAmount?: false }
  | { readonly credits: number; readonly customAmount: true };

export function apiTierToBillingTier(tier: string | undefined): BillingTier {
  if (
    tier === "free" ||
    tier === "pro-suspend" ||
    tier === "pro" ||
    tier === "team"
  ) {
    return tier;
  }
  return "pro-suspend";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
const billingReload$ = state(0);
interface CompletedBillingCheckout {
  readonly tier: CompletedBillingCheckoutTier;
  readonly sessionId: string | null;
}

const internalCompletedBillingCheckout$ =
  state<CompletedBillingCheckout | null>(null);
const internalDowngradeDialogOpen$ = state(false);
const internalPendingEnabled$ = state<boolean | null>(null);
const internalFormThresholdOverride$ = state<string | null>(null);
const internalFormAmountOverride$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const billingDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});
export const downgradeDialogOpen$ = computed((get) => {
  return get(internalDowngradeDialogOpen$);
});
export const pendingEnabled$ = computed((get) => {
  return get(internalPendingEnabled$);
});
export const completedBillingCheckout$ = computed((get) => {
  return get(internalCompletedBillingCheckout$);
});

export const setPendingEnabled$ = command(({ set }, value: boolean | null) => {
  set(internalPendingEnabled$, value);
});
export const markCompletedBillingCheckout$ = command(
  (
    { set },
    tier: CompletedBillingCheckoutTier,
    sessionId: string | null = null,
  ) => {
    set(internalCompletedBillingCheckout$, { tier, sessionId });
  },
);
export const clearCompletedBillingCheckout$ = command(({ set }) => {
  set(internalCompletedBillingCheckout$, null);
});

/**
 * Async computed signal that fetches billing status on first access.
 * Use with useLastLoadable() in views for automatic loading.
 */
export const billingStatusAsync$ = computed(async (get) => {
  get(billingReload$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingStatusContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Force a refetch of billing status (e.g. after onboarding creates the org row). */
export const reloadBillingStatus$ = command(({ set }) => {
  set(billingReload$, (x) => {
    return x + 1;
  });
});

export const setBillingDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalDialogOpen$, open);
});

export const startCheckout$ = command(
  async (
    { get },
    tier: "pro" | "team",
    newTab: boolean,
    options: { readonly trialDays?: 7 } | undefined,
    signal: AbortSignal,
  ) => {
    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("billing", tier);
    successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
    applyStoredAdAttribution(successUrl);
    const stripeSuccessUrl = successUrl
      .toString()
      .replace(
        "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
        "billing_session_id={CHECKOUT_SESSION_ID}",
      );
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("billing", "canceled");
    applyStoredAdAttribution(cancelUrl);
    const adAttribution = getStoredAdAttributionMetadata();

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingCheckoutContract);
    const result = await accept(
      client.create({
        body: {
          tier,
          successUrl: stripeSuccessUrl,
          cancelUrl: cancelUrl.toString(),
          ...(options?.trialDays === undefined
            ? {}
            : { trialDays: options.trialDays }),
          ...(adAttribution === undefined ? {} : { adAttribution }),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (newTab) {
      window.open(result.body.url, "_blank");
    } else {
      window.location.href = result.body.url;
      // Don't reset loading — page is navigating away
    }
  },
);

export const completeCheckoutSession$ = command(
  async ({ get }, sessionId: string, signal: AbortSignal): Promise<boolean> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingCheckoutContract);
    const result = await accept(
      client.complete({
        body: { sessionId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body.completed;
  },
);

export const startCreditCheckout$ = command(
  async (
    { get },
    selection: CreditCheckoutSelection,
    newTab: boolean,
    signal: AbortSignal,
  ) => {
    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("credits", "purchased");
    successUrl.searchParams.set(
      "credit_checkout_session_id",
      "{CHECKOUT_SESSION_ID}",
    );
    const stripeSuccessUrl = successUrl
      .toString()
      .replace(
        "credit_checkout_session_id=%7BCHECKOUT_SESSION_ID%7D",
        "credit_checkout_session_id={CHECKOUT_SESSION_ID}",
      );
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("credits", "canceled");

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingCreditCheckoutContract);
    const result = await accept(
      client.create({
        body: {
          credits: selection.credits,
          ...(selection.customAmount === true ? { customAmount: true } : {}),
          successUrl: stripeSuccessUrl,
          cancelUrl: cancelUrl.toString(),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (newTab) {
      window.open(result.body.url, "_blank");
    } else {
      window.location.href = result.body.url;
    }
  },
);

export const startDowngrade$ = command(async ({ get }, signal: AbortSignal) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingPortalContract);
  const result = await accept(
    client.create({
      body: { returnUrl: window.location.href },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();
  window.location.href = result.body.url;
});

// ---------------------------------------------------------------------------
// Downgrade dialog commands
// ---------------------------------------------------------------------------

export const openDowngradeDialog$ = command(({ set }) => {
  set(internalDowngradeDialogOpen$, true);
});

export const closeDowngradeDialog$ = command(({ set }) => {
  set(internalDowngradeDialogOpen$, false);
});

export const confirmDowngrade$ = command(
  async (
    { get, set },
    targetTier: "pro-suspend" | "pro",
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingDowngradeContract);
    await accept(
      client.create({
        body: { targetTier },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalDowngradeDialogOpen$, false);
    // Reload billing status to reflect the change
    set(billingReload$, (x) => {
      return x + 1;
    });
  },
);

// ---------------------------------------------------------------------------
// Auto-recharge config (reload pattern)
// ---------------------------------------------------------------------------

/**
 * Pure computed derived from billingStatusAsync$.
 * Re-derives automatically when billingReload$ bumps (after save).
 * The component reads this via useLastLoadable for display and form values.
 */
export const autoRechargeConfig$ = computed(async (get) => {
  const status = await get(billingStatusAsync$);
  const ar = status.autoRecharge;
  return {
    enabled: ar.enabled,
    threshold: ar.threshold !== null ? String(ar.threshold) : "",
    amount: ar.amount !== null ? String(ar.amount) : "",
  };
});

// ---------------------------------------------------------------------------
// Form override signals — derive from autoRechargeConfig$ when no override set
// ---------------------------------------------------------------------------

export const formThreshold$ = computed(async (get) => {
  const override = get(internalFormThresholdOverride$);
  if (override !== null) {
    return override;
  }
  const config = await get(autoRechargeConfig$);
  return config.threshold;
});
export const formAmount$ = computed(async (get) => {
  const override = get(internalFormAmountOverride$);
  if (override !== null) {
    return override;
  }
  const config = await get(autoRechargeConfig$);
  return config.amount;
});

export const setFormThreshold$ = command(({ set }, value: string) => {
  set(internalFormThresholdOverride$, value);
});
export const setFormAmount$ = command(({ set }, value: string) => {
  set(internalFormAmountOverride$, value);
});

/**
 * Auto-recharge has unsaved changes when the user has toggled the switch
 * (pendingEnabled is non-null and differs from saved) or when threshold/amount
 * overrides differ from the saved values.
 */
export const autoRechargeDirty$ = computed(async (get) => {
  const config = await get(autoRechargeConfig$);
  const pendingEnabled = get(internalPendingEnabled$);
  if (pendingEnabled !== null && pendingEnabled !== config.enabled) {
    return true;
  }
  const thresholdOverride = get(internalFormThresholdOverride$);
  if (thresholdOverride !== null && thresholdOverride !== config.threshold) {
    return true;
  }
  const amountOverride = get(internalFormAmountOverride$);
  if (amountOverride !== null && amountOverride !== config.amount) {
    return true;
  }
  return false;
});

export const discardAutoRecharge$ = command(({ set }) => {
  set(internalPendingEnabled$, null);
  set(internalFormThresholdOverride$, null);
  set(internalFormAmountOverride$, null);
});

// ---------------------------------------------------------------------------
// Auto-recharge save
// ---------------------------------------------------------------------------

export const saveAutoRecharge$ = command(
  async (
    { get, set },
    config: { enabled: boolean; threshold?: number; amount?: number },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingAutoRechargeContract);
    await accept(
      client.update({
        body: config,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    // Kick off a refetch first so autoRechargeConfig$ has a new in-flight
    // promise carrying the just-saved values.
    set(billingReload$, (x) => {
      return x + 1;
    });
    // Keep the optimistic overrides in place until the refetch resolves.
    // Otherwise there's a visible flash between the override-clear and the
    // refetch-complete where `displayEnabled` falls back to the stale
    // last-resolved config (useLastLoadable returns the pre-save value):
    // toggling ON and saving would blink to OFF for ~one network RTT, and
    // the unsaved-bar briefly disappears because `autoRechargeDirty$` goes
    // false when all overrides are null against the stale config. If the
    // refetch fails, `accept()` inside billingStatusAsync$ already surfaces
    // the error; leaving overrides in place lets the user retry or discard.
    await get(autoRechargeConfig$);
    signal.throwIfAborted();
    set(internalPendingEnabled$, null);
    set(internalFormThresholdOverride$, null);
    set(internalFormAmountOverride$, null);
    toast.success("Auto-recharge updated");
  },
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const invoicesAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingInvoicesContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

// ---------------------------------------------------------------------------
// Buy credits form state (Billing page > Buy credits section)
// ---------------------------------------------------------------------------

export type BuyCreditsSelection = 10 | 20 | 50 | "custom";

const internalBuyCreditsSelection$ = state<BuyCreditsSelection>(20);
const internalBuyCreditsCustomDollars$ = state("");

export const buyCreditsSelection$ = computed((get) => {
  return get(internalBuyCreditsSelection$);
});
export const buyCreditsCustomDollars$ = computed((get) => {
  return get(internalBuyCreditsCustomDollars$);
});

export const setBuyCreditsSelection$ = command(
  ({ set }, value: BuyCreditsSelection) => {
    set(internalBuyCreditsSelection$, value);
  },
);
export const setBuyCreditsCustomDollars$ = command(({ set }, value: string) => {
  set(internalBuyCreditsCustomDollars$, value);
});
