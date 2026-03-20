import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { logger } from "../log.ts";
import { setSelectedPlanTier$ } from "./billing-dialog-state.ts";

const log = logger("billing");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingTier = "free" | "pro" | "max";

export interface BillingStatus {
  tier: BillingTier;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
const internalDialogLoading$ = state(false);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const billingDialogOpen$ = computed((get) => get(internalDialogOpen$));
export const billingDialogLoading$ = computed((get) =>
  get(internalDialogLoading$),
);

/**
 * Async computed signal that fetches billing status on first access.
 * Use with useLastLoadable() in views for automatic loading.
 */
export const billingStatusAsync$ = computed(async (get) => {
  const fetchFn = await get(fetch$);
  const response = await fetchFn("/api/billing/status");
  if (!response.ok) {
    log.error("Failed to fetch billing status", response.status);
    return null;
  }
  const data = (await response.json()) as BillingStatus;
  return data;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const openBillingDialog$ = command(async ({ get, set }) => {
  const status = await get(billingStatusAsync$);
  const currentTier = (status?.tier as BillingTier) ?? "free";
  set(setSelectedPlanTier$, currentTier);
  set(internalDialogOpen$, true);
});

export const closeBillingDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

export const startCheckout$ = command(
  async ({ get, set }, tier: "pro" | "max") => {
    set(internalDialogLoading$, true);

    const fetchFn = get(fetch$);
    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("billing", "success");
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("billing", "canceled");

    const response = await fetchFn("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier,
        successUrl: successUrl.toString(),
        cancelUrl: cancelUrl.toString(),
      }),
    });

    const data = (await response.json()) as {
      url?: string;
      error?: string;
    };

    if (data.url) {
      window.location.href = data.url;
      // Don't reset loading — page is navigating away
    } else {
      log.error("Checkout failed", data.error);
      set(internalDialogLoading$, false);
    }
  },
);

export const startDowngrade$ = command(async ({ get, set }) => {
  set(internalDialogLoading$, true);

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/billing/portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnUrl: window.location.href }),
  });

  const data = (await response.json()) as {
    url?: string;
    error?: string;
  };

  if (data.url) {
    window.location.href = data.url;
  } else {
    log.error("Portal redirect failed", data.error);
    set(internalDialogLoading$, false);
  }
});
