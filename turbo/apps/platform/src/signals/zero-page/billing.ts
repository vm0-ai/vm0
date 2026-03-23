import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import {
  setSelectedPlanTier$,
  syncAutoRechargeForm$,
} from "./billing-dialog-state.ts";

const log = logger("billing");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingTier = "free" | "pro" | "team";

interface AutoRechargeConfig {
  enabled: boolean;
  threshold: number | null;
  amount: number | null;
}

export interface BillingStatus {
  tier: BillingTier;
  credits: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  autoRecharge: AutoRechargeConfig;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
const internalDialogLoading$ = state(false);
const billingReload$ = state(0);

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
  get(billingReload$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingStatusContract);
  const result = await client.get();
  if (result.status !== 200) {
    log.error("Failed to fetch billing status", result.status);
    return null;
  }
  return result.body as BillingStatus;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const openBillingDialog$ = command(async ({ get, set }) => {
  const status = await get(billingStatusAsync$);
  const currentTier = (status?.tier as BillingTier) ?? "free";
  set(setSelectedPlanTier$, currentTier);
  set(
    syncAutoRechargeForm$,
    status?.autoRecharge ?? {
      enabled: false,
      threshold: null,
      amount: null,
    },
  );
  set(internalDialogOpen$, true);
});

export const closeBillingDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

export const startCheckout$ = command(
  async ({ get, set }, tier: "pro" | "team") => {
    set(internalDialogLoading$, true);

    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("billing", "success");
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("billing", "canceled");

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingCheckoutContract);
    const result = await client.create({
      body: {
        tier,
        successUrl: successUrl.toString(),
        cancelUrl: cancelUrl.toString(),
      },
    });

    if (result.status === 200 && result.body.url) {
      window.location.href = result.body.url;
      // Don't reset loading — page is navigating away
    } else {
      const errorBody = result.body as { error?: { message?: string } };
      log.error("Checkout failed", errorBody.error?.message);
      set(internalDialogLoading$, false);
    }
  },
);

export const startDowngrade$ = command(async ({ get, set }) => {
  set(internalDialogLoading$, true);

  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingPortalContract);
  const result = await client.create({
    body: { returnUrl: window.location.href },
  });

  if (result.status === 200 && result.body.url) {
    window.location.href = result.body.url;
  } else {
    const errorBody = result.body as { error?: { message?: string } };
    log.error("Portal redirect failed", errorBody.error?.message);
    set(internalDialogLoading$, false);
  }
});

// ---------------------------------------------------------------------------
// Auto-recharge
// ---------------------------------------------------------------------------

export const saveAutoRecharge$ = command(
  async (
    { get, set },
    config: { enabled: boolean; threshold?: number; amount?: number },
  ) => {
    set(internalDialogLoading$, true);

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingAutoRechargeContract);
    const result = await client.update({ body: config });

    set(internalDialogLoading$, false);

    if (result.status !== 200) {
      const errorBody = result.body as { error?: { message?: string } };
      log.error("Auto-recharge save failed", errorBody.error?.message);
      return { ok: false, error: errorBody.error?.message };
    }

    // Invalidate billing status cache so the dialog shows fresh data on re-open
    set(billingReload$, (x) => x + 1);

    return { ok: true };
  },
);
