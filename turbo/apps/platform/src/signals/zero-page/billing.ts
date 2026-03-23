import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  type BillingStatusResponse,
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

export type BillingStatus = BillingStatusResponse;

function isBillingTier(tier: string): tier is BillingTier {
  return tier === "free" || tier === "pro" || tier === "team";
}

function toBillingTier(tier: string): BillingTier {
  return isBillingTier(tier) ? tier : "free";
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

export const openBillingDialog$ = command(async ({ get, set }) => {
  const status = await get(billingStatusAsync$);
  const currentTier = toBillingTier(status.tier);
  set(setSelectedPlanTier$, currentTier);
  set(syncAutoRechargeForm$, status.autoRecharge);
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

    if (result.status === 200) {
      window.location.href = result.body.url;
      // Don't reset loading — page is navigating away
    } else {
      log.error("Checkout failed", getErrorMessage(result.body));
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

  if (result.status === 200) {
    window.location.href = result.body.url;
  } else {
    log.error("Portal redirect failed", getErrorMessage(result.body));
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
      const message = getErrorMessage(result.body);
      log.error("Auto-recharge save failed", message);
      return { ok: false, error: message };
    }

    // Invalidate billing status cache so the dialog shows fresh data on re-open
    set(billingReload$, (x) => x + 1);

    return { ok: true };
  },
);
