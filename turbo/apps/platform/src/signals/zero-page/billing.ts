import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  zeroBillingDowngradeContract,
  zeroBillingRestoreContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroClient$ } from "../api-client.ts";
import { reloadUsageRecords$ } from "./settings/personal-usage-record.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { tapError } from "../utils.ts";
import { accept } from "../../lib/accept.ts";
import {
  applyStoredAdAttribution,
  getStoredAdAttributionMetadata,
} from "../bootstrap/ad-attribution.ts";
import { currentLocale, i18n } from "../../i18n/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BillingTier =
  | "free"
  | "limited-free-1"
  | "pro-suspend"
  | "pro"
  | "team"
  | "custom";
type DowngradeTargetTier = "limited-free-1" | "pro-suspend" | "pro";
export type CreditCheckoutSelection =
  | { readonly credits: number; readonly customAmount?: false }
  | { readonly credits: number; readonly customAmount: true };

const RESTORE_PAYMENT_PENDING_KEY = "vm0:billing:restore-payment-pending";
const DOWNGRADE_PAYMENT_PENDING_KEY = "vm0:billing:downgrade-payment-pending";
export const CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN = 1;
export const CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX = 1000;

function formatEffectiveDate(effectiveDate: string | null): string | null {
  if (!effectiveDate) {
    return null;
  }

  const date = new Date(effectiveDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function apiTierToBillingTier(tier: string | undefined): BillingTier {
  if (
    tier === "free" ||
    tier === "limited-free-1" ||
    tier === "pro-suspend" ||
    tier === "pro" ||
    tier === "team" ||
    tier === "custom"
  ) {
    return tier;
  }
  return "pro-suspend";
}

function pendingRestoreStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

function rememberPendingRestorePayment(): void {
  pendingRestoreStorage()?.setItem(RESTORE_PAYMENT_PENDING_KEY, "1");
}

function clearPendingRestorePayment(): void {
  pendingRestoreStorage()?.removeItem(RESTORE_PAYMENT_PENDING_KEY);
}

function downgradeSuccessToastMessage(
  targetTier: DowngradeTargetTier,
  effectiveDateValue: string | null,
): string {
  const effectiveDate = formatEffectiveDate(effectiveDateValue);
  if (targetTier === "limited-free-1" || targetTier === "pro-suspend") {
    return effectiveDate
      ? i18n.t(
          ($) => {
            return $.billing.toasts.cancellationScheduledDate;
          },
          { date: effectiveDate },
        )
      : i18n.t(($) => {
          return $.billing.toasts.cancellationScheduledPeriod;
        });
  }

  return effectiveDate
    ? i18n.t(
        ($) => {
          return $.billing.toasts.downgradeScheduledDate;
        },
        { date: effectiveDate },
      )
    : i18n.t(($) => {
        return $.billing.toasts.downgradeScheduledPeriod;
      });
}

function rememberPendingDowngradePayment(
  targetTier: DowngradeTargetTier,
): void {
  pendingRestoreStorage()?.setItem(DOWNGRADE_PAYMENT_PENDING_KEY, targetTier);
}

function clearPendingDowngradePayment(): void {
  pendingRestoreStorage()?.removeItem(DOWNGRADE_PAYMENT_PENDING_KEY);
}

function pendingDowngradeTargetTier(
  value: string | null,
): DowngradeTargetTier | null {
  if (
    value === "pro" ||
    value === "limited-free-1" ||
    value === "pro-suspend"
  ) {
    return value;
  }
  return null;
}

function maybeShowPendingDowngradeToast(status: BillingStatusResponse): void {
  const storage = pendingRestoreStorage();
  const targetTier = pendingDowngradeTargetTier(
    storage?.getItem(DOWNGRADE_PAYMENT_PENDING_KEY) ?? null,
  );
  if (!targetTier) {
    return;
  }

  const scheduledChange = status.scheduledChange;
  const scheduled =
    targetTier === "pro"
      ? scheduledChange?.type === "downgrade" &&
        scheduledChange.targetTier === "pro"
      : scheduledChange?.type === "cancel" || status.cancelAtPeriodEnd;
  if (!scheduled) {
    return;
  }

  storage?.removeItem(DOWNGRADE_PAYMENT_PENDING_KEY);
  toast.success(
    downgradeSuccessToastMessage(
      targetTier,
      scheduledChange?.effectiveDate ?? status.currentPeriodEnd,
    ),
  );
}

function maybeShowPendingRestoreToast(status: BillingStatusResponse): void {
  const storage = pendingRestoreStorage();
  if (storage?.getItem(RESTORE_PAYMENT_PENDING_KEY) !== "1") {
    return;
  }

  const tier = apiTierToBillingTier(status.tier);
  const restored =
    status.hasSubscription &&
    (tier === "pro" || tier === "team" || tier === "custom") &&
    !status.cancelAtPeriodEnd &&
    status.scheduledChange === null;
  if (!restored) {
    return;
  }

  storage.removeItem(RESTORE_PAYMENT_PENDING_KEY);
  toast.success(
    i18n.t(($) => {
      return $.billing.toasts.planRestored;
    }),
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const billingReload$ = state(0);
const internalDowngradeDialogOpen$ = state(false);
const internalRestoreDialogOpen$ = state(false);
const internalPendingEnabled$ = state<boolean | null>(null);
const internalFormThresholdOverride$ = state<string | null>(null);
const internalFormAmountOverride$ = state<string | null>(null);
const internalConcurrencySubscriptionQuantity$ = state<number | null>(null);
const internalConcurrencyPurchaseDialogOpen$ = state(false);
const internalConcurrencyConfirmDialog$ = state<{
  readonly action: "cancel" | "restore";
  readonly subscriptionId: string;
} | null>(null);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const downgradeDialogOpen$ = computed((get) => {
  return get(internalDowngradeDialogOpen$);
});
export const restoreDialogOpen$ = computed((get) => {
  return get(internalRestoreDialogOpen$);
});
export const pendingEnabled$ = computed((get) => {
  return get(internalPendingEnabled$);
});
export const concurrencySubscriptionQuantity$ = computed((get) => {
  return get(internalConcurrencySubscriptionQuantity$);
});
export const concurrencyPurchaseDialogOpen$ = computed((get) => {
  return get(internalConcurrencyPurchaseDialogOpen$);
});
export const concurrencyConfirmDialog$ = computed((get) => {
  return get(internalConcurrencyConfirmDialog$);
});

export const setPendingEnabled$ = command(({ set }, value: boolean | null) => {
  set(internalPendingEnabled$, value);
});
export const setConcurrencySubscriptionQuantity$ = command(
  ({ set }, value: number | null) => {
    if (value === null) {
      set(internalConcurrencySubscriptionQuantity$, null);
      return;
    }
    set(
      internalConcurrencySubscriptionQuantity$,
      Math.min(
        CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX,
        Math.max(CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN, value),
      ),
    );
  },
);
export const openConcurrencyPurchaseDialog$ = command(({ set }) => {
  set(internalConcurrencySubscriptionQuantity$, null);
  set(internalConcurrencyPurchaseDialogOpen$, true);
});
export const closeConcurrencyPurchaseDialog$ = command(({ set }) => {
  set(internalConcurrencyPurchaseDialogOpen$, false);
});
export const openConcurrencyConfirmDialog$ = command(
  ({ set }, action: "cancel" | "restore", subscriptionId: string) => {
    set(internalConcurrencyConfirmDialog$, { action, subscriptionId });
  },
);
export const closeConcurrencyConfirmDialog$ = command(({ set }) => {
  set(internalConcurrencyConfirmDialog$, null);
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
  maybeShowPendingRestoreToast(result.body);
  maybeShowPendingDowngradeToast(result.body);
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

const reloadBillingStatusFromRealtime$ = command(({ set }) => {
  set(reloadBillingStatus$);
  set(reloadUsageRecords$);
  return false;
});

export const setupBillingRealtime$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyLoop$,
      {
        topic: "billing:changed",
        loopCommand$: reloadBillingStatusFromRealtime$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

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

export const startConcurrencyCheckout$ = command(
  async ({ get }, quantity: number, newTab: boolean, signal: AbortSignal) => {
    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("concurrency", "purchased");
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("concurrency", "canceled");

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencyCheckoutContract);
    const result = await accept(
      client.create({
        body: {
          quantity,
          successUrl: successUrl.toString(),
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

export const cancelConcurrencySubscription$ = command(
  async ({ get, set }, subscriptionId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencySubscriptionContract);
    const result = await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(billingReload$, (x) => {
      return x + 1;
    });
    set(internalConcurrencyConfirmDialog$, null);
    const effectiveDate = formatEffectiveDate(result.body.currentPeriodEnd);
    toast.success(
      effectiveDate
        ? i18n.t(
            ($) => {
              return $.billing.toasts.concurrencyCanceledDate;
            },
            { date: effectiveDate },
          )
        : i18n.t(($) => {
            return $.billing.toasts.concurrencyCanceled;
          }),
    );
  },
);

export const restoreConcurrencySubscription$ = command(
  async ({ get, set }, subscriptionId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencySubscriptionContract);
    await accept(
      client.restore({
        params: { subscriptionId },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(billingReload$, (x) => {
      return x + 1;
    });
    set(internalConcurrencyConfirmDialog$, null);
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.concurrencyRestored;
      }),
    );
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

export const openRestoreDialog$ = command(({ set }) => {
  set(internalRestoreDialogOpen$, true);
});

export const closeRestoreDialog$ = command(({ set }) => {
  set(internalRestoreDialogOpen$, false);
});

export const confirmDowngrade$ = command(
  async (
    { get, set },
    targetTier: "limited-free-1" | "pro-suspend" | "pro",
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingDowngradeContract);
    const result = await accept(
      client.create({
        body: { targetTier, returnUrl: window.location.href },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const response = result.body;
    if (!("success" in response)) {
      rememberPendingDowngradePayment(targetTier);
      set(internalDowngradeDialogOpen$, false);
      window.location.assign(response.checkoutUrl);
      return;
    }

    clearPendingDowngradePayment();
    set(internalDowngradeDialogOpen$, false);
    // Reload billing status to reflect the change
    set(billingReload$, (x) => {
      return x + 1;
    });
    toast.success(
      downgradeSuccessToastMessage(targetTier, response.effectiveDate),
    );
  },
);

export const restorePlan$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingRestoreContract);
    const result = await accept(
      client.create({
        body: { returnUrl: window.location.href },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (result.body.status === "payment_method_required") {
      rememberPendingRestorePayment();
      set(internalRestoreDialogOpen$, false);
      window.location.assign(result.body.checkoutUrl);
      return;
    }

    clearPendingRestorePayment();
    set(internalRestoreDialogOpen$, false);
    set(billingReload$, (x) => {
      return x + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.planRestored;
      }),
    );
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
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.autoRechargeUpdated;
      }),
    );
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

interface ReceiptDownloadRange {
  readonly startMonth: string;
  readonly endMonth: string;
}

const internalReceiptDownloadRange$ = state<ReceiptDownloadRange>({
  startMonth: "",
  endMonth: "",
});

export const receiptDownloadRange$ = computed((get) => {
  return get(internalReceiptDownloadRange$);
});

export const receiptDownloadRangeExceedsLimit$ = computed((get) => {
  const range = get(internalReceiptDownloadRange$);
  if (range.startMonth === "" || range.endMonth === "") {
    return false;
  }
  const monthIndex = (month: string) => {
    return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  };
  return (
    Math.abs(monthIndex(range.endMonth) - monthIndex(range.startMonth)) >= 3
  );
});

export const initializeReceiptDownloadRange$ = command(
  ({ set }, month: string) => {
    set(internalReceiptDownloadRange$, {
      startMonth: month,
      endMonth: month,
    });
  },
);

export const setReceiptDownloadStartMonth$ = command(
  ({ get, set }, startMonth: string) => {
    const range = get(internalReceiptDownloadRange$);
    set(internalReceiptDownloadRange$, { ...range, startMonth });
  },
);

export const setReceiptDownloadEndMonth$ = command(
  ({ get, set }, endMonth: string) => {
    const range = get(internalReceiptDownloadRange$);
    set(internalReceiptDownloadRange$, { ...range, endMonth });
  },
);

export const downloadMonthlyReceipts$ = command(
  async ({ get }, range: ReceiptDownloadRange, signal: AbortSignal) => {
    const toastId = toast.loading(
      i18n.t(($) => {
        return $.billing.toasts.preparingReceiptDownload;
      }),
    );
    signal.addEventListener(
      "abort",
      () => {
        toast.dismiss(toastId);
      },
      { once: true },
    );
    const downloaded = await tapError(
      (async () => {
        const createClient = get(zeroClient$);
        const client = createClient(zeroBillingInvoicesContract);
        const response = await accept(
          client.downloadReceipts({
            query: range,
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();

        const url = URL.createObjectURL(response.body);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download =
          range.startMonth === range.endMonth
            ? `receipts-${range.startMonth}.zip`
            : `receipts-${range.startMonth}-to-${range.endMonth}.zip`;
        anchor.click();
        URL.revokeObjectURL(url);
        return true;
      })(),
      () => {
        toast.error(
          i18n.t(($) => {
            return $.billing.toasts.receiptDownloadFailed;
          }),
          { id: toastId },
        );
      },
    );
    signal.throwIfAborted();
    if (downloaded) {
      toast.success(
        i18n.t(($) => {
          return $.billing.toasts.receiptsDownloaded;
        }),
        { id: toastId },
      );
    }
  },
);

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
