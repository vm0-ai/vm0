import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { ConcurrencyInfo } from "@vm0/api-contracts/contracts/runs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Button,
} from "@vm0/ui";
import { IconCrown, IconMinus, IconPlus } from "@tabler/icons-react";
import {
  CONCURRENCY_QUANTITY_MAX,
  CONCURRENCY_QUANTITY_MIN,
  concurrencyQuantity$,
  queueDrawerOpen$,
  resetConcurrencyQuantity$,
  setConcurrencyQuantity$,
  setQueueDrawerOpen$,
} from "../../signals/queue-page/queue-drawer-state.ts";
import { queueData$ } from "../../signals/queue-page/queue-signals.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  startCheckout$,
  startConcurrencyCheckout$,
} from "../../signals/zero-page/billing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { orgPlanCapabilities$ } from "../../signals/zero-page/org-plan-capabilities.ts";

// ---------------------------------------------------------------------------
// Upgrade path config: free → pro, pro → team
// ---------------------------------------------------------------------------

interface UpgradePath {
  targetTier: "pro" | "team";
  targetLabel: string;
  concurrentRuns: number;
  monthlyPriceUsd: number;
  description: string;
  features: readonly string[];
}

const UPGRADE_PATHS = {
  free: {
    targetTier: "pro",
    targetLabel: "Pro",
    concurrentRuns: 2,
    monthlyPriceUsd: 20,
  },
  pro: {
    targetTier: "team",
    targetLabel: "Team",
    concurrentRuns: 10,
    monthlyPriceUsd: 200,
  },
} as const;

const CONCURRENCY_SLOT_MONTHLY_PRICE_USD = 100;

function concurrencyMonthlyTotal(quantity: number): number {
  return quantity * CONCURRENCY_SLOT_MONTHLY_PRICE_USD;
}

function useUpgradePath(tier: string): UpgradePath | undefined {
  const { i18n, t } = useTranslation();
  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage);
  const base =
    tier in UPGRADE_PATHS
      ? UPGRADE_PATHS[tier as keyof typeof UPGRADE_PATHS]
      : undefined;
  if (!base) {
    return undefined;
  }
  const credits = base.targetTier === "pro" ? 20_000 : 120_000;
  const support =
    base.targetTier === "pro"
      ? t(($) => {
          return $.queue.upgrade.features.emailSupport;
        })
      : t(($) => {
          return $.queue.upgrade.features.prioritySupport;
        });
  return {
    ...base,
    description:
      base.targetTier === "pro"
        ? t(($) => {
            return $.queue.upgrade.proDescription;
          })
        : t(($) => {
            return $.queue.upgrade.teamDescription;
          }),
    features: [
      t(
        ($) => {
          return $.queue.upgrade.features.creditsPerMonth;
        },
        { credits: numberFormat.format(credits) },
      ),
      t(($) => {
        return $.queue.upgrade.features.payAsYouGo;
      }),
      t(
        ($) => {
          return $.queue.concurrentRuns;
        },
        { count: base.concurrentRuns },
      ),
      t(($) => {
        return $.queue.upgrade.features.unlimitedAgents;
      }),
      t(($) => {
        return $.queue.upgrade.features.ownKeys;
      }),
      support,
    ],
  };
}

// ---------------------------------------------------------------------------
// Check icon matching plan comparison page
// ---------------------------------------------------------------------------

function CheckCircleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted-foreground/40"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="16 9 10.5 15 8 12.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Drawer content
// ---------------------------------------------------------------------------

function CurrentPlanStatus({
  concurrency,
  tierColor,
  tierLabel,
}: {
  readonly concurrency: ConcurrencyInfo;
  readonly tierColor: string;
  readonly tierLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 rounded-xl zero-border p-5">
      <p
        className={`text-sm font-semibold uppercase tracking-wider font-mono mb-3 ${tierColor}`}
      >
        {tierLabel}
      </p>
      <div className="flex items-center gap-2 mb-2">
        {Array.from({ length: concurrency.limit }, (_, i) => {
          const filled = i < concurrency.active;
          return (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full ${filled ? "bg-destructive" : "bg-muted"}`}
            />
          );
        })}
      </div>
      <p className="text-lg font-medium text-foreground">
        {t(
          ($) => {
            return $.queue.status.inUse;
          },
          {
            active: concurrency.active,
            count: concurrency.limit,
            limit: concurrency.limit,
          },
        )}
      </p>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mt-1.5">
        {concurrency.available === 0
          ? t(
              ($) => {
                return $.queue.status.atLimit;
              },
              {
                count: concurrency.limit,
                limit: concurrency.limit,
              },
            )
          : t(
              ($) => {
                return $.queue.status.available;
              },
              { count: concurrency.available },
            )}
      </p>
    </div>
  );
}

function UpgradeCard({
  loading,
  onCheckout,
  tierColor,
  upgrade,
}: {
  readonly loading: boolean;
  readonly onCheckout: (newTab: boolean) => void;
  readonly tierColor: string;
  readonly upgrade: UpgradePath;
}) {
  const { i18n, t } = useTranslation();
  const currencyFormat = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return (
    <div className="flex-1 flex flex-col rounded-xl zero-border p-5">
      <div className="flex items-start justify-between mb-2">
        <h3
          className={`text-sm font-semibold uppercase tracking-wider font-mono ${tierColor}`}
        >
          {upgrade.targetLabel}
        </h3>
        <span className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconCrown size={12} stroke={1.8} className="text-amber-500" />
          {t(($) => {
            return $.queue.upgrade.recommended;
          })}
        </span>
      </div>

      <p className="text-lg font-medium text-foreground mb-1">
        {t(
          ($) => {
            return $.queue.concurrentRuns;
          },
          { count: upgrade.concurrentRuns },
        )}
      </p>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-4">
        {upgrade.description}
      </p>

      <div className="flex items-baseline gap-1.5 mb-4">
        <span className="text-2xl font-light tracking-tight text-foreground">
          {currencyFormat.format(upgrade.monthlyPriceUsd)}
        </span>
        <span className="text-sm font-light text-muted-foreground">
          {t(($) => {
            return $.queue.perMonth;
          })}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {upgrade.features.map((feature: string) => {
          return (
            <li key={feature} className="flex items-center gap-2">
              <CheckCircleIcon />
              <span className="text-[13px] font-light text-muted-foreground">
                {feature}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto pt-5">
        <Button
          className="w-full h-11 text-sm font-medium"
          disabled={loading}
          onClick={(e) => {
            onCheckout(e.metaKey || e.ctrlKey);
          }}
        >
          {loading
            ? t(($) => {
                return $.queue.redirecting;
              })
            : t(
                ($) => {
                  return $.queue.upgrade.action;
                },
                { plan: upgrade.targetLabel },
              )}
        </Button>
      </div>
    </div>
  );
}

function ConcurrencyQuantityControl({
  loading,
  onQuantityChange,
  quantity,
}: {
  readonly loading: boolean;
  readonly onQuantityChange: (quantity: number) => void;
  readonly quantity: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.queue.purchase.quantity;
          })}
        </span>
        <div className="flex h-9 items-center rounded-lg border border-border/70 bg-background">
          <button
            type="button"
            aria-label={t(($) => {
              return $.queue.purchase.decreaseQuantity;
            })}
            disabled={quantity <= CONCURRENCY_QUANTITY_MIN || loading}
            className="flex h-9 w-9 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              onQuantityChange(quantity - 1);
            }}
          >
            <IconMinus size={14} stroke={2} />
          </button>
          <span className="flex h-9 w-12 items-center justify-center border-x border-border/70 text-sm font-medium tabular-nums text-foreground">
            {quantity}
          </span>
          <button
            type="button"
            aria-label={t(($) => {
              return $.queue.purchase.increaseQuantity;
            })}
            disabled={quantity >= CONCURRENCY_QUANTITY_MAX || loading}
            className="flex h-9 w-9 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              onQuantityChange(quantity + 1);
            }}
          >
            <IconPlus size={14} stroke={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ConcurrencyPurchaseCard({
  loading,
  onCheckout,
  onQuantityChange,
  quantity,
  tierColor,
}: {
  readonly loading: boolean;
  readonly onCheckout: (newTab: boolean) => void;
  readonly onQuantityChange: (quantity: number) => void;
  readonly quantity: number;
  readonly tierColor: string;
}) {
  const { i18n, t } = useTranslation();
  const currencyFormat = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  const monthlyTotal = currencyFormat.format(concurrencyMonthlyTotal(quantity));
  return (
    <div className="flex-1 flex flex-col rounded-xl zero-border p-5">
      <div className="flex items-start justify-between mb-2">
        <h3
          className={`text-sm font-semibold uppercase tracking-wider font-mono ${tierColor}`}
        >
          {t(($) => {
            return $.queue.purchase.title;
          })}
        </h3>
        <span className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconCrown size={12} stroke={1.8} className="text-amber-500" />
          {t(($) => {
            return $.queue.purchase.addOn;
          })}
        </span>
      </div>

      <p className="text-lg font-medium text-foreground mb-1">
        {t(
          ($) => {
            return $.queue.purchase.subscription;
          },
          { count: quantity },
        )}
      </p>
      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-4">
        {t(($) => {
          return $.queue.purchase.description;
        })}
      </p>

      <ConcurrencyQuantityControl
        loading={loading}
        onQuantityChange={onQuantityChange}
        quantity={quantity}
      />

      <p className="mt-4 text-sm font-medium text-foreground">
        {t(
          ($) => {
            return $.queue.pricePerMonth;
          },
          { price: monthlyTotal },
        )}
      </p>

      <ul className="flex flex-col gap-2 mt-4">
        <li className="flex items-center gap-2">
          <CheckCircleIcon />
          <span className="text-[13px] font-light text-muted-foreground">
            {t(($) => {
              return $.queue.purchase.addsToLimit;
            })}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <CheckCircleIcon />
          <span className="text-[13px] font-light text-muted-foreground">
            {t(($) => {
              return $.queue.purchase.appliedAfterCheckout;
            })}
          </span>
        </li>
      </ul>

      <div className="mt-auto pt-5">
        <Button
          className="w-full h-11 text-sm font-medium"
          disabled={loading}
          onClick={(e) => {
            onCheckout(e.metaKey || e.ctrlKey);
          }}
        >
          {loading
            ? t(($) => {
                return $.queue.redirecting;
              })
            : t(
                ($) => {
                  return $.queue.purchase.buy;
                },
                { price: monthlyTotal },
              )}
        </Button>
      </div>
    </div>
  );
}

function QueueDrawerContent() {
  const { t } = useTranslation();
  const dataLoadable = useLastLoadable(queueData$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const pageSignal = useGet(pageSignal$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const [planCheckoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const [concurrencyCheckoutLoadable, concurrencyCheckout] = useLoadableSet(
    startConcurrencyCheckout$,
  );
  const concurrencyQuantity = useGet(concurrencyQuantity$);
  const setConcurrencyQuantity = useSet(setConcurrencyQuantity$);
  const capabilities = useLastResolved(orgPlanCapabilities$);
  const planCheckoutLoading = planCheckoutLoadable.state === "loading";
  const concurrencyCheckoutLoading =
    concurrencyCheckoutLoadable.state === "loading";
  const upgrade = useUpgradePath(data?.concurrency.tier ?? "");

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-24 animate-pulse rounded-xl bg-muted/20" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/20" />
      </div>
    );
  }

  const { concurrency } = data;
  const tierLabel =
    concurrency.tier === "limited-free-1"
      ? t(($) => {
          return $.queue.tiers.limitedFree;
        })
      : concurrency.tier === "pro-suspend"
        ? t(($) => {
            return $.queue.tiers.noPlan;
          })
        : concurrency.tier === "free"
          ? t(($) => {
              return $.queue.tiers.free;
            })
          : concurrency.tier === "pro"
            ? t(($) => {
                return $.queue.tiers.pro;
              })
            : concurrency.tier === "team"
              ? t(($) => {
                  return $.queue.tiers.team;
                })
              : t(($) => {
                  return $.queue.tiers.custom;
                });
  const canManageBilling =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const visibleUpgrade = canManageBilling ? upgrade : undefined;
  const showConcurrencyPurchase =
    canManageBilling && capabilities?.canBuyConcurrency === true;

  const tierColor = "text-[#D27939]";

  return (
    <div className="flex flex-col gap-4 h-full">
      <CurrentPlanStatus
        concurrency={concurrency}
        tierColor={tierColor}
        tierLabel={tierLabel}
      />

      {visibleUpgrade && (
        <UpgradeCard
          loading={planCheckoutLoading}
          onCheckout={(newTab) => {
            detach(
              checkout(
                visibleUpgrade.targetTier,
                newTab,
                undefined,
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
          tierColor={tierColor}
          upgrade={visibleUpgrade}
        />
      )}

      {showConcurrencyPurchase && (
        <ConcurrencyPurchaseCard
          loading={concurrencyCheckoutLoading}
          onCheckout={(newTab) => {
            detach(
              concurrencyCheckout(concurrencyQuantity, newTab, pageSignal),
              Reason.DomCallback,
            );
          }}
          onQuantityChange={setConcurrencyQuantity}
          quantity={concurrencyQuantity}
          tierColor={tierColor}
        />
      )}
    </div>
  );
}

export function QueueDrawer() {
  const { t } = useTranslation();
  const open = useGet(queueDrawerOpen$);
  const pageSignal = useGet(pageSignal$);
  const setOpen = useSet(setQueueDrawerOpen$);
  const resetConcurrencyQuantity = useSet(resetConcurrencyQuantity$);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setOpen(false, pageSignal);
          resetConcurrencyQuantity();
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[400px] flex flex-col"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
        }}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>
            {t(($) => {
              return $.queue.title;
            })}
          </SheetTitle>
          <SheetDescription>
            {t(($) => {
              return $.queue.description;
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
          <QueueDrawerContent />
        </div>
      </SheetContent>
    </Sheet>
  );
}
