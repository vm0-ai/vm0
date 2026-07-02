import { command, computed, state } from "ccstate";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { reloadPersonalModelProviders$ } from "../external/personal-model-providers.ts";
import { personalConfiguredProviders$ } from "./settings/personal-model-providers.ts";

export type AccountMenuSubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
export type AccountMenuSubscriptionUsageWindow = NonNullable<
  AccountMenuSubscriptionUsage["fiveHour"]
>;

export interface AccountMenuSubscriptionUsageRow {
  readonly type: ModelProviderType;
  readonly label: string;
  readonly usage: AccountMenuSubscriptionUsage;
}

export type AccountMenuSubscriptionUsageRowsCacheKey = string | null;

export const ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS = [
  { type: "codex-oauth-token", label: "Codex" },
  { type: "claude-code-oauth-token", label: "Claude Code" },
] as const satisfies readonly {
  readonly type: ModelProviderType;
  readonly label: string;
}[];

interface AccountMenuSubscriptionUsageRowsCache {
  readonly key: AccountMenuSubscriptionUsageRowsCacheKey;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[] | null;
}

const internalAccountMenuSubscriptionUsageRowsRequestId$ = state(0);
const internalAccountMenuSubscriptionUsageRowsRefreshPromise$ =
  state<Promise<void> | null>(null);
const internalAccountMenuSubscriptionUsageRowsCache$ =
  state<AccountMenuSubscriptionUsageRowsCache>({
    key: null,
    rows: null,
  });

export const accountMenuSubscriptionUsageRowsCache$ = computed((get) => {
  return get(internalAccountMenuSubscriptionUsageRowsCache$);
});

export const accountMenuSubscriptionUsageRowsRefreshPromise$ = computed(
  (get) => {
    return get(internalAccountMenuSubscriptionUsageRowsRefreshPromise$);
  },
);

export const reloadAccountMenuSubscriptionUsageRows$ = command(
  (
    { get, set },
    key: AccountMenuSubscriptionUsageRowsCacheKey,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const requestId =
      get(internalAccountMenuSubscriptionUsageRowsRequestId$) + 1;
    set(internalAccountMenuSubscriptionUsageRowsRequestId$, requestId);

    const promise = (async () => {
      set(reloadPersonalModelProviders$);
      const providers = await get(personalConfiguredProviders$);
      signal.throwIfAborted();
      if (
        get(internalAccountMenuSubscriptionUsageRowsRequestId$) !== requestId
      ) {
        return;
      }
      const rows = accountMenuSubscriptionUsageRows(providers);
      set(internalAccountMenuSubscriptionUsageRowsCache$, { key, rows });
    })();

    set(internalAccountMenuSubscriptionUsageRowsRefreshPromise$, promise);

    return promise;
  },
);

function accountMenuSubscriptionUsageRows(
  providers: readonly ModelProviderResponse[],
): readonly AccountMenuSubscriptionUsageRow[] {
  return ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.flatMap((definition) => {
    const provider = providers.find((candidate) => {
      return candidate.type === definition.type;
    });
    if (!provider) {
      return [];
    }
    const usage = fallbackSubscriptionUsage(provider);
    if (!usage || accountMenuSubscriptionUsageWindows(usage).length === 0) {
      return [];
    }
    return [{ ...definition, usage }];
  });
}

export function accountMenuSubscriptionUsageWindows(
  usage: AccountMenuSubscriptionUsage | null | undefined,
): readonly {
  readonly label: string;
  readonly window: AccountMenuSubscriptionUsageWindow;
}[] {
  return [
    { label: "5h", window: usage?.fiveHour ?? null },
    { label: "week", window: usage?.weekly ?? null },
  ].filter(
    (
      item,
    ): item is {
      label: string;
      window: AccountMenuSubscriptionUsageWindow;
    } => {
      return hasUsageWindow(item.window);
    },
  );
}

function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): AccountMenuSubscriptionUsage | null {
  if (
    accountMenuSubscriptionUsageWindows(provider.subscriptionUsage).length > 0
  ) {
    return provider.subscriptionUsage ?? null;
  }

  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };

  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}

function hasUsageWindow(
  window: AccountMenuSubscriptionUsage["fiveHour"],
): window is AccountMenuSubscriptionUsageWindow {
  return (
    window !== null &&
    (window.remainingPercent !== null ||
      window.usedPercent !== null ||
      window.resetAt !== null)
  );
}
