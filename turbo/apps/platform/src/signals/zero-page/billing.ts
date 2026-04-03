import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  zeroBillingDowngradeContract,
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
const billingReload$ = state(0);
const internalDowngradeDialogOpen$ = state(false);
const internalPendingEnabled$ = state<boolean | null>(null);
const internalFormThreshold$ = state("");
const internalFormAmount$ = state("");

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

export const setPendingEnabled$ = command(({ set }, value: boolean | null) => {
  set(internalPendingEnabled$, value);
});

export const formThreshold$ = computed((get) => {
  return get(internalFormThreshold$);
});
export const formAmount$ = computed((get) => {
  return get(internalFormAmount$);
});

export const setFormThreshold$ = command(({ set }, value: string) => {
  set(internalFormThreshold$, value);
});
export const setFormAmount$ = command(({ set }, value: string) => {
  set(internalFormAmount$, value);
});

export const syncFormFromConfig$ = command(
  ({ set }, config: { threshold: string; amount: string }) => {
    set(internalFormThreshold$, config.threshold);
    set(internalFormAmount$, config.amount);
  },
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
  set(billingReload$, (x) => {
    return x + 1;
  });
});

export const closeBillingDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

export const startCheckout$ = command(
  async ({ get }, tier: "pro" | "team", _signal: AbortSignal) => {
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
      throw new Error(getErrorMessage(result.body) ?? "Checkout failed");
    }
  },
);

export const startDowngrade$ = command(
  async ({ get }, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingPortalContract);
    const result = await client.create({
      body: { returnUrl: window.location.href },
    });

    if (result.status === 200) {
      window.location.href = result.body.url;
    } else {
      log.error("Portal redirect failed", getErrorMessage(result.body));
      throw new Error(getErrorMessage(result.body) ?? "Portal redirect failed");
    }
  },
);

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
  async ({ get, set }, targetTier: "free" | "pro", _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingDowngradeContract);
    const result = await client.create({
      body: { targetTier },
    });

    if (result.status === 200) {
      set(internalDowngradeDialogOpen$, false);
      // Reload billing status to reflect the change
      set(billingReload$, (x) => {
        return x + 1;
      });
    } else {
      const message =
        getErrorMessage(result.body) ?? "Failed to downgrade plan";
      log.error("Downgrade failed", message);
      throw new Error(message);
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
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingAutoRechargeContract);
    const result = await client.update({ body: config });

    if (result.status !== 200) {
      const message = getErrorMessage(result.body);
      log.error("Auto-recharge save failed", message);
      throw new Error(message ?? "Auto-recharge save failed");
    }

    // Reload billing status — autoRechargeConfig$ re-derives automatically
    set(billingReload$, (x) => {
      return x + 1;
    });
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
