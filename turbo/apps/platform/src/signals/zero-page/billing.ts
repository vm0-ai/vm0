import { command, computed, state } from "ccstate";
import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingUsagePackCreditsContract,
  zeroBillingUsagePackMigrationContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  zeroBillingDowngradeContract,
  zeroBillingRestoreContract,
  type BillingStatusResponse,
  type ConcurrencySubscriptionChangePreviewResponse,
  type MemberUsagePack,
  type UsagePackMigrationStateResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroClient$ } from "../api-client.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { reloadUsageRecords$ } from "./settings/personal-usage-record.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { tapError } from "../utils.ts";
import { accept } from "../../lib/accept.ts";
import {
  applyStoredAdAttribution$,
  readStoredAdAttributionMetadata$,
} from "../bootstrap/ad-attribution.ts";
import {
  capturePaidOnboardingCheckoutCreated$,
  capturePaidOnboardingRedirectToStripe$,
} from "../bootstrap/paid-funnel-telemetry.ts";
import { currentLocale, i18n } from "../../i18n/index.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import {
  setUsagePackMigrationRevisionPreview$,
  setUsagePackMigrationPreview$,
  setUsagePackSubscriptionChangePreview$,
  usagePackMigrationRevisionPreview$,
  usagePackSubscriptionChangePreview$,
} from "./settings/usage-pack-pricing-state.ts";

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
export type ConcurrencyChangeMode = "quantity" | "cancel";

const RESTORE_PAYMENT_PENDING_KEY = "vm0:billing:restore-payment-pending";
const DOWNGRADE_PAYMENT_PENDING_KEY = "vm0:billing:downgrade-payment-pending";
const restorePaymentPendingStorage = sessionStorageSignals(
  RESTORE_PAYMENT_PENDING_KEY,
);
const downgradePaymentPendingStorage = sessionStorageSignals(
  DOWNGRADE_PAYMENT_PENDING_KEY,
);
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

const rememberPendingRestorePayment$ = command(({ set }) => {
  set(restorePaymentPendingStorage.set$, "1");
});

const clearPendingRestorePayment$ = command(({ set }) => {
  set(restorePaymentPendingStorage.clear$);
});

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

const rememberPendingDowngradePayment$ = command(
  ({ set }, targetTier: DowngradeTargetTier) => {
    set(downgradePaymentPendingStorage.set$, targetTier);
  },
);

const clearPendingDowngradePayment$ = command(({ set }) => {
  set(downgradePaymentPendingStorage.clear$);
});

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

const maybeShowPendingDowngradeToast$ = command(
  ({ get, set }, status: BillingStatusResponse): void => {
    const targetTier = pendingDowngradeTargetTier(
      get(downgradePaymentPendingStorage.get$),
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

    set(downgradePaymentPendingStorage.clear$);
    toast.success(
      downgradeSuccessToastMessage(
        targetTier,
        scheduledChange?.effectiveDate ?? status.currentPeriodEnd,
      ),
    );
  },
);

const maybeShowPendingRestoreToast$ = command(
  ({ get, set }, status: BillingStatusResponse): void => {
    if (get(restorePaymentPendingStorage.get$) !== "1") {
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

    set(restorePaymentPendingStorage.clear$);
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.planRestored;
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const billingReload$ = state(0);
const usagePackManagementReload$ = state(0);
const usagePackMigrationReload$ = state(0);
const internalDowngradeDialogOpen$ = state(false);
const internalRestoreDialogOpen$ = state(false);
const internalPendingEnabled$ = state<boolean | null>(null);
const internalFormThresholdOverride$ = state<string | null>(null);
const internalFormAmountOverride$ = state<string | null>(null);
const internalConcurrencySubscriptionQuantity$ = state<number | null>(null);
const internalConcurrencyPurchaseDialogOpen$ = state(false);

export interface ConcurrencyConfirmDialogState {
  readonly action: "change" | "restore";
  readonly subscriptionId: string;
  readonly currentQuantity: number;
  readonly canReduce: boolean;
  readonly canChangeInApp: boolean;
  readonly changeMode: ConcurrencyChangeMode;
  readonly targetQuantity: number | null;
  readonly preview: ConcurrencySubscriptionChangePreviewResponse | null;
}

const internalConcurrencyConfirmDialog$ =
  state<ConcurrencyConfirmDialogState | null>(null);

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
  (
    { set },
    args: {
      readonly action: "change" | "restore";
      readonly subscriptionId: string;
      readonly currentQuantity: number;
      readonly canReduce: boolean;
      readonly canChangeInApp: boolean;
    },
  ) => {
    set(internalConcurrencyConfirmDialog$, {
      action: args.action,
      subscriptionId: args.subscriptionId,
      currentQuantity: args.currentQuantity,
      canReduce: args.action === "change" && args.canReduce,
      canChangeInApp: args.action === "change" && args.canChangeInApp,
      changeMode: "quantity",
      targetQuantity: args.action === "change" ? args.currentQuantity : null,
      preview: null,
    });
  },
);
export const closeConcurrencyConfirmDialog$ = command(({ set }) => {
  set(internalConcurrencyConfirmDialog$, null);
});
export const setConcurrencyChangeMode$ = command(
  ({ set }, mode: ConcurrencyChangeMode) => {
    set(internalConcurrencyConfirmDialog$, (dialog) => {
      if (!dialog || dialog.action !== "change") {
        return dialog;
      }
      return { ...dialog, changeMode: mode, preview: null };
    });
  },
);
export const setConcurrencyTargetQuantity$ = command(
  ({ set }, quantity: number | null) => {
    set(internalConcurrencyConfirmDialog$, (dialog) => {
      if (!dialog || dialog.action !== "change") {
        return dialog;
      }
      return { ...dialog, targetQuantity: quantity, preview: null };
    });
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
  const result = await accept(client.get(), [200]);
  return result.body;
});

export const usagePackCatalogAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingUsagePackCatalogContract);
  const result = await accept(client.get(), [200]);
  return result.body.usagePacks;
});

export const usagePackManagementAsync$ = computed(async (get) => {
  get(usagePackManagementReload$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingUsagePackManagementContract);
  const result = await accept(client.get(), [200, 404]);
  return result.status === 200 ? result.body : null;
});

export const usagePackCreditsAsync$ = computed(async (get) => {
  get(billingReload$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroBillingUsagePackCreditsContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

export const usagePackMigrationAsync$ = computed(
  async (get): Promise<UsagePackMigrationStateResponse | null> => {
    get(usagePackMigrationReload$);
    if (!get(featureSwitch$)[FeatureSwitchKey.UsagePackPlans]) {
      return null;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackMigrationContract);
    const result = await accept(client.get(), [200, 403, 404, 409]);
    return result.status === 200 ? result.body : null;
  },
);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Force a refetch of billing status (e.g. after onboarding creates the org row). */
export const reloadBillingStatus$ = command(({ set }) => {
  set(billingReload$, (x) => {
    return x + 1;
  });
});

export const reloadUsagePackManagement$ = command(({ set }) => {
  set(usagePackManagementReload$, (value) => {
    return value + 1;
  });
});

const reloadUsagePackMigration$ = command(({ set }) => {
  set(usagePackMigrationReload$, (value) => {
    return value + 1;
  });
});

export const handleBillingRedirect$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const hasPendingPayment =
      get(restorePaymentPendingStorage.get$) === "1" ||
      pendingDowngradeTargetTier(get(downgradePaymentPendingStorage.get$)) !==
        null;
    if (hasPendingPayment) {
      const status = await get(billingStatusAsync$);
      signal.throwIfAborted();
      set(maybeShowPendingRestoreToast$, status);
      set(maybeShowPendingDowngradeToast$, status);
    }

    const searchParams = new URLSearchParams(get(searchParams$));
    const billing = searchParams.get("billing");
    const credits = searchParams.get("credits");
    const concurrency = searchParams.get("concurrency");
    if (!billing && !credits && !concurrency) {
      return;
    }

    searchParams.delete("billing");
    searchParams.delete("billing_session_id");
    searchParams.delete("credits");
    searchParams.delete("credit_checkout_session_id");
    searchParams.delete("concurrency");
    set(replaceSearchParams$, searchParams);

    if (billing === "pro" || billing === "team") {
      const label =
        billing === "pro"
          ? i18n.t(($) => {
              return $.billing.plans.pro.name;
            })
          : i18n.t(($) => {
              return $.billing.plans.team.name;
            });
      toast.success(
        i18n.t(
          ($) => {
            return $.billing.toasts.checkoutCompleted;
          },
          { plan: label },
        ),
      );
      set(reloadBillingStatus$);
    }

    if (credits === "purchased") {
      toast.success(
        i18n.t(($) => {
          return $.billing.toasts.creditsAdded;
        }),
      );
      set(reloadBillingStatus$);
    }

    if (concurrency === "purchased") {
      toast.success(
        i18n.t(($) => {
          return $.billing.toasts.concurrencyAdded;
        }),
      );
      set(reloadBillingStatus$);
    }

    if (concurrency === "reduced") {
      toast.success(
        i18n.t(($) => {
          return $.billing.toasts.concurrencyReduced;
        }),
      );
      set(reloadBillingStatus$);
    }
  },
);

const reloadBillingStatusFromRealtime$ = command(({ set }) => {
  set(reloadBillingStatus$);
  set(reloadUsagePackManagement$);
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

function checkoutReturnUrl(): URL {
  return new URL(window.location.pathname, window.location.origin);
}

export const startCheckout$ = command(
  async (
    { get, set },
    tier: "pro" | "team",
    newTab: boolean,
    options: { readonly trialDays?: 7 } | undefined,
    signal: AbortSignal,
  ) => {
    const successUrl = checkoutReturnUrl();
    successUrl.searchParams.set("billing", tier);
    successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
    set(applyStoredAdAttribution$, successUrl);
    const stripeSuccessUrl = successUrl
      .toString()
      .replace(
        "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
        "billing_session_id={CHECKOUT_SESSION_ID}",
      );
    const cancelUrl = checkoutReturnUrl();
    cancelUrl.searchParams.set("billing", "canceled");
    set(applyStoredAdAttribution$, cancelUrl);
    const adAttribution = set(readStoredAdAttributionMetadata$);

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
    set(capturePaidOnboardingCheckoutCreated$, "paywall");
    set(capturePaidOnboardingRedirectToStripe$, "paywall");
    if (newTab) {
      window.open(result.body.url, "_blank");
    } else {
      window.location.href = result.body.url;
      // Don't reset loading — page is navigating away
    }
  },
);

export const startUsagePackCheckout$ = command(
  async (
    { get, set },
    args: {
      readonly tier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    newTab: boolean,
    signal: AbortSignal,
  ) => {
    const currentUrl = window.location.href;
    const successUrl = new URL(currentUrl);
    successUrl.searchParams.set("billing", args.tier);
    successUrl.searchParams.set("billing_session_id", "{CHECKOUT_SESSION_ID}");
    set(applyStoredAdAttribution$, successUrl);
    const stripeSuccessUrl = successUrl
      .toString()
      .replace(
        "billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
        "billing_session_id={CHECKOUT_SESSION_ID}",
      );
    const cancelUrl = new URL(currentUrl);
    cancelUrl.searchParams.set("billing", "canceled");
    set(applyStoredAdAttribution$, cancelUrl);
    const adAttribution = set(readStoredAdAttributionMetadata$);

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackCheckoutContract);
    const result = await accept(
      client.create({
        body: {
          tier: args.tier,
          memberUsagePacks: [...args.memberUsagePacks],
          successUrl: stripeSuccessUrl,
          cancelUrl: cancelUrl.toString(),
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
    }
  },
);

export const previewUsagePackMigration$ = command(
  async (
    { get, set },
    args: {
      readonly targetTier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackMigrationContract);
    const result = await accept(
      client.preview({
        body: {
          targetTier: args.targetTier,
          memberUsagePacks: [...args.memberUsagePacks],
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(setUsagePackMigrationPreview$, result.body);
    return result.body;
  },
);

export const confirmUsagePackMigration$ = command(
  async ({ get, set }, migrationId: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackMigrationContract);
    const result = await accept(
      client.confirm({
        params: { migrationId },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(setUsagePackMigrationPreview$, null);
    set(reloadUsagePackMigration$);
    set(reloadUsagePackManagement$);
    set(reloadBillingStatus$);
    return result.body;
  },
);

export const previewUsagePackMigrationRevision$ = command(
  async (
    { get, set },
    args: {
      readonly migrationId: string;
      readonly targetTier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackMigrationContract);
    const result = await accept(
      client.previewRevision({
        params: { migrationId: args.migrationId },
        body: {
          targetTier: args.targetTier,
          memberUsagePacks: [...args.memberUsagePacks],
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(setUsagePackMigrationRevisionPreview$, result.body);
    return result.body;
  },
);

export const confirmUsagePackMigrationRevision$ = command(
  async (
    { get, set },
    args: {
      readonly migrationId: string;
      readonly targetTier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ) => {
    const preview = get(usagePackMigrationRevisionPreview$);
    if (
      !preview ||
      preview.migrationId !== args.migrationId ||
      preview.targetTier !== args.targetTier
    ) {
      throw new Error("Usage pack migration revision preview is not open");
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackMigrationContract);
    const result = await accept(
      client.confirmRevision({
        params: { migrationId: args.migrationId },
        body: {
          targetTier: args.targetTier,
          memberUsagePacks: [...args.memberUsagePacks],
          previewToken: preview.previewToken,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.subscriptionChangeConfirmed;
      }),
    );
    set(setUsagePackMigrationRevisionPreview$, null);
    set(reloadUsagePackMigration$);
    set(reloadBillingStatus$);
    return result.body;
  },
);

export const previewUsagePackSubscriptionChange$ = command(
  async (
    { get, set },
    args: {
      readonly targetTier: "pro" | "team";
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackManagementContract);
    const preview = await accept(
      client.previewSubscriptionChange({
        body: {
          targetTier: args.targetTier,
          memberUsagePacks: [...args.memberUsagePacks],
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(setUsagePackSubscriptionChangePreview$, preview.body);
    return preview.body;
  },
);

export const closeUsagePackSubscriptionChangePreview$ = command(({ set }) => {
  set(setUsagePackSubscriptionChangePreview$, null);
});

export const confirmUsagePackSubscriptionChange$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const preview = get(usagePackSubscriptionChangePreview$);
    if (!preview) {
      throw new Error("Usage pack subscription change preview is not open");
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingUsagePackManagementContract);
    const result = await accept(
      client.confirmSubscriptionChange({
        body: { changeId: preview.changeId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.subscriptionChangeConfirmed;
      }),
    );
    set(setUsagePackSubscriptionChangePreview$, null);
    set(reloadUsagePackManagement$);
    set(reloadBillingStatus$);
    return result.body;
  },
);

export const startCreditCheckout$ = command(
  async (
    { get },
    selection: CreditCheckoutSelection,
    newTab: boolean,
    signal: AbortSignal,
  ) => {
    const successUrl = checkoutReturnUrl();
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
    const cancelUrl = checkoutReturnUrl();
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
    const successUrl = new URL("/", window.location.origin);
    successUrl.searchParams.set("concurrency", "purchased");
    const cancelUrl = checkoutReturnUrl();
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

interface ConcurrencySubscriptionChangePreviewArgs {
  readonly subscriptionId: string;
  readonly quantity: number;
}

const loadConcurrencySubscriptionChangePreview$ = command(
  async (
    { get },
    args: ConcurrencySubscriptionChangePreviewArgs,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencySubscriptionContract);
    const result = await accept(
      client.previewChange({
        params: { subscriptionId: args.subscriptionId },
        body: { quantity: args.quantity },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const previewConcurrencySubscriptionChange$ = command(
  async (
    { set },
    args: ConcurrencySubscriptionChangePreviewArgs,
    signal: AbortSignal,
  ) => {
    const preview = await set(
      loadConcurrencySubscriptionChangePreview$,
      args,
      signal,
    );
    signal.throwIfAborted();
    set(internalConcurrencyConfirmDialog$, (dialog) => {
      if (
        !dialog ||
        dialog.subscriptionId !== args.subscriptionId ||
        dialog.targetQuantity !== args.quantity
      ) {
        return dialog;
      }
      return { ...dialog, preview };
    });
  },
);

export const openConcurrencyChangeReview$ = command(
  async (
    { set },
    args: {
      readonly subscriptionId: string;
      readonly currentQuantity: number;
      readonly targetQuantity: number;
      readonly canReduce: boolean;
    },
    signal: AbortSignal,
  ) => {
    const preview = await set(
      loadConcurrencySubscriptionChangePreview$,
      {
        subscriptionId: args.subscriptionId,
        quantity: args.targetQuantity,
      },
      signal,
    );
    signal.throwIfAborted();
    set(internalConcurrencyConfirmDialog$, {
      action: "change",
      subscriptionId: args.subscriptionId,
      currentQuantity: args.currentQuantity,
      canReduce: args.canReduce,
      canChangeInApp: true,
      changeMode: "quantity",
      targetQuantity: args.targetQuantity,
      preview,
    });
  },
);

export const confirmConcurrencySubscriptionChange$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialog = get(internalConcurrencyConfirmDialog$);
    if (!dialog?.preview) {
      throw new Error("Concurrency change preview is not available");
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencySubscriptionContract);
    const result = await accept(
      client.confirmChange({
        params: { subscriptionId: dialog.subscriptionId },
        body: { quantity: dialog.preview.targetQuantity },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (result.body.status === "pending_payment") {
      window.location.href = result.body.hostedInvoiceUrl;
      return;
    }
    set(billingReload$, (x) => {
      return x + 1;
    });
    set(internalConcurrencyConfirmDialog$, null);
    toast.success(
      i18n.t(($) => {
        return $.billing.toasts.concurrencyChanged;
      }),
    );
  },
);

export const startConcurrencyReduction$ = command(
  async (
    { get },
    args: { readonly subscriptionId: string; readonly quantity: number },
    signal: AbortSignal,
  ) => {
    const successUrl = new URL("/", window.location.origin);
    successUrl.searchParams.set("concurrency", "reduced");
    const cancelUrl = checkoutReturnUrl();
    cancelUrl.searchParams.set("concurrency", "canceled");

    const createClient = get(zeroClient$);
    const client = createClient(zeroBillingConcurrencySubscriptionContract);
    const result = await accept(
      client.reduce({
        params: { subscriptionId: args.subscriptionId },
        body: {
          quantity: args.quantity,
          successUrl: successUrl.toString(),
          cancelUrl: cancelUrl.toString(),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    window.location.href = result.body.url;
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

export const openBillingPortal$ = command(
  async ({ get }, newTab: boolean, signal: AbortSignal) => {
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
    if (newTab) {
      window.open(result.body.url, "_blank");
    } else {
      window.location.href = result.body.url;
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
      set(rememberPendingDowngradePayment$, targetTier);
      set(internalDowngradeDialogOpen$, false);
      window.location.assign(response.checkoutUrl);
      return;
    }

    set(clearPendingDowngradePayment$);
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
      set(rememberPendingRestorePayment$);
      set(internalRestoreDialogOpen$, false);
      window.location.assign(result.body.checkoutUrl);
      return;
    }

    set(clearPendingRestorePayment$);
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
