import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  type BillingStatusResponse,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";

const log = logger("billing");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingTier = "free" | "pro" | "team";

export type BillingStatus = BillingStatusResponse;

export function apiTierToBillingTier(tier: string | undefined): BillingTier {
  if (tier === "free" || tier === "pro" || tier === "team") {
    return tier;
  }
  return "free";
}

/** Extract error message from a ts-rest error response body. */
function getErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const { error } = body;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  const { message } = error;
  return typeof message === "string" ? message : undefined;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
const internalCheckoutLoading$ = state(false);
const internalPortalLoading$ = state(false);
const billingReload$ = state(0);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const billingDialogOpen$ = computed((get) => get(internalDialogOpen$));
export const billingDialogLoading$ = computed(
  (get) => get(internalCheckoutLoading$) || get(internalPortalLoading$),
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
    throw new Error(`Failed to fetch billing status: ${result.status}`);
  }
  return result.body;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Force a refetch of billing status (e.g. after onboarding creates the org row). */
export const reloadBillingStatus$ = command(({ set }) => {
  set(billingReload$, (x) => x + 1);
});

export const closeBillingDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

export const startCheckout$ = command(
  async ({ get, set }, tier: "pro" | "team", _signal: AbortSignal) => {
    set(internalCheckoutLoading$, true);

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

    if (result.status === 200) {
      window.location.href = result.body.url;
      // Don't reset loading — page is navigating away
    } else {
      log.error("Checkout failed", getErrorMessage(result.body));
      set(internalCheckoutLoading$, false);
    }
  },
);

export const startDowngrade$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    set(internalPortalLoading$, true);

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingPortalContract);
    const result = await client.create({
      body: { returnUrl: window.location.href },
    });

    if (result.status === 200) {
      window.location.href = result.body.url;
    } else {
      log.error("Portal redirect failed", getErrorMessage(result.body));
      set(internalPortalLoading$, false);
    }
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
// Auto-recharge save
// ---------------------------------------------------------------------------

export const saveAutoRecharge$ = command(
  async (
    { get, set },
    config: { enabled: boolean; threshold?: number; amount?: number },
    _signal: AbortSignal,
  ) => {
    set(internalCheckoutLoading$, true);

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingAutoRechargeContract);
    const result = await client.update({ body: config });

    set(internalCheckoutLoading$, false);

    if (result.status !== 200) {
      const message = getErrorMessage(result.body);
      log.error("Auto-recharge save failed", message);
      return { ok: false, error: message };
    }

    // Reload billing status — autoRechargeConfig$ re-derives automatically
    set(billingReload$, (x) => x + 1);

    return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const invoicesAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingInvoicesContract);
  const result = await client.get();
  if (result.status !== 200) {
    throw new Error(`Failed to fetch invoices: ${result.status}`);
  }
  return result.body;
});
