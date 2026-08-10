import { ArrowLeft, Check, Crown, User } from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import type {
  MemberUsagePack,
  UsagePackCatalogItem,
} from "@vm0/api-contracts/contracts/zero-billing";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { i18n } from "../../../../i18n/index.ts";
import { currentUserInfo$ } from "../../../../signals/auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  startUsagePackCheckout$,
  type BillingTier,
  usagePackCatalogAsync$,
} from "../../../../signals/zero-page/billing.ts";
import {
  orgMembers$,
  orgPendingInvitations$,
  type OrgMember,
} from "../../../../signals/external/org-members.ts";
import {
  memberUsageSelections$,
  MINIMUM_USAGE_PACK_USD,
  selectedUsagePackPlan$,
  setMemberUsageSelection$,
  setSelectedUsagePackPlan$,
  USAGE_PACKS_USD,
  usagePackPricingPageRef$,
  type MemberUsageSelection,
  type UsagePackPlanTier,
  type UsagePackUsd,
} from "../../../../signals/zero-page/settings/usage-pack-pricing-state.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { planProImg, planTeamImg } from "../../platform-assets.ts";

interface UsagePackPlan {
  readonly tier: UsagePackPlanTier;
  readonly basePriceUsd: number;
  readonly image: string;
  readonly popular: boolean;
}

interface MemberDisplay {
  readonly id: string;
  readonly email: string | undefined;
  readonly imageUrl: string | undefined;
  readonly isCurrent: boolean;
  readonly isPending: boolean;
  readonly name: string;
}

const USAGE_PACK_PLANS: readonly UsagePackPlan[] = [
  {
    tier: "pro",
    basePriceUsd: 0,
    image: planProImg,
    popular: true,
  },
  {
    tier: "team",
    basePriceUsd: 160,
    image: planTeamImg,
    popular: false,
  },
];

function canCheckoutUsagePackPlan(
  currentTier: BillingTier,
  targetTier: UsagePackPlanTier,
): boolean {
  if (currentTier === "custom" || currentTier === "team") {
    return false;
  }
  return currentTier !== "pro" || targetTier === "team";
}

function planName(tier: UsagePackPlanTier): string {
  return tier === "pro"
    ? i18n.t(($) => {
        return $.billing.plans.pro.name;
      })
    : i18n.t(($) => {
        return $.billing.plans.team.name;
      });
}

function planDescription(tier: UsagePackPlanTier): string {
  return tier === "pro"
    ? i18n.t(($) => {
        return $.billing.plans.pro.description;
      })
    : i18n.t(($) => {
        return $.billing.plans.team.description;
      });
}

function planFeatures(tier: UsagePackPlanTier): readonly string[] {
  return [
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.twoConcurrentRuns;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.tenConcurrentRuns;
        }),
    i18n.t(($) => {
      return $.billing.plans.features.unlimitedAgents;
    }),
    i18n.t(($) => {
      return $.billing.plans.features.byok;
    }),
    i18n.t(($) => {
      return $.billing.plans.features.voiceInput;
    }),
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.emailSupport;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.prioritySupport;
        }),
  ];
}

function usagePackCatalogItem(
  catalog: readonly UsagePackCatalogItem[],
  usagePackUsd: UsagePackUsd,
): UsagePackCatalogItem {
  const item = catalog.find((candidate) => {
    return candidate.usagePackUsd === usagePackUsd;
  });
  if (!item) {
    throw new Error(`Usage pack catalog is missing $${usagePackUsd}`);
  }
  return item;
}

function usagePackDiscountPercent(item: UsagePackCatalogItem): number {
  return Math.round((item.bonusCredits / item.totalCredits) * 100);
}

function usageSelectionLabel(
  selection: MemberUsageSelection,
  catalog: readonly UsagePackCatalogItem[],
): string {
  const item = usagePackCatalogItem(catalog, selection);
  return i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.packOption;
    },
    {
      credits: formatLocalizedNumber(item.totalCredits),
      discount: usagePackDiscountPercent(item),
      price: formatUsd(item.priceUsd, 0),
    },
  );
}

function parseUsageSelection(value: string): MemberUsageSelection {
  const pack = USAGE_PACKS_USD.find((candidate) => {
    return String(candidate) === value;
  });
  if (pack === undefined) {
    throw new Error(`Unknown member usage selection: ${value}`);
  }
  return pack;
}

function memberUsageSelection(
  selections: Readonly<Record<string, MemberUsageSelection>>,
  memberId: string,
): MemberUsageSelection {
  return selections[memberId] ?? MINIMUM_USAGE_PACK_USD;
}

interface MemberUsageTotals {
  readonly bonusCredits: number;
  readonly totalCredits: number;
  readonly totalUsd: number;
}

function memberUsageTotals(
  members: readonly MemberDisplay[],
  selections: Readonly<Record<string, MemberUsageSelection>>,
  catalog: readonly UsagePackCatalogItem[],
): MemberUsageTotals {
  return members.reduce<MemberUsageTotals>(
    (totals, member) => {
      const selection = memberUsageSelection(selections, member.id);
      const item = usagePackCatalogItem(catalog, selection);
      return {
        bonusCredits: totals.bonusCredits + item.bonusCredits,
        totalCredits: totals.totalCredits + item.totalCredits,
        totalUsd: totals.totalUsd + item.priceUsd,
      };
    },
    { bonusCredits: 0, totalCredits: 0, totalUsd: 0 },
  );
}

function checkoutMemberUsagePacks(
  members: readonly MemberDisplay[],
  selections: Readonly<Record<string, MemberUsageSelection>>,
): readonly MemberUsagePack[] {
  return members.map((member) => {
    return {
      memberId: member.id,
      usagePackUsd: memberUsageSelection(selections, member.id),
    };
  });
}

function memberName(member: OrgMember): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name || member.email;
}

function MemberIdentity({ member }: { readonly member: MemberDisplay }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground">
        {member.imageUrl ? (
          <img
            src={member.imageUrl}
            alt={member.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <User size={15} />
        )}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {member.name}
          </span>
          {member.isCurrent && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground zero-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.you;
              })}
            </span>
          )}
          {member.isPending && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground zero-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.pending;
              })}
            </span>
          )}
        </span>
        {member.email && member.email !== member.name && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {member.email}
          </span>
        )}
      </span>
    </div>
  );
}

function MemberUsageRow({
  catalog,
  member,
  onSelect,
  selection,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly member: MemberDisplay;
  readonly onSelect: (selection: MemberUsageSelection) => void;
  readonly selection: MemberUsageSelection;
}) {
  const item = usagePackCatalogItem(catalog, selection);
  const summary = i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.bonusCredits;
    },
    {
      value: formatLocalizedNumber(item.bonusCredits),
    },
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)] items-center gap-3 px-4 py-3">
      <MemberIdentity member={member} />
      <div className="min-w-0">
        <Select
          value={String(selection)}
          onValueChange={(value) => {
            onSelect(parseUsageSelection(value));
          }}
        >
          <SelectTrigger
            className="h-9 w-full bg-background text-xs"
            aria-label={i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.selectUsage;
              },
              { name: member.name },
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalog.map((pack) => {
              return (
                <SelectItem
                  key={pack.usagePackUsd}
                  value={String(pack.usagePackUsd)}
                >
                  {usageSelectionLabel(pack.usagePackUsd, catalog)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {summary}
        </p>
      </div>
    </div>
  );
}

function MemberUsageHeader({
  usagePackTotalUsd,
}: {
  readonly usagePackTotalUsd: number;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.memberUsage;
          })}
        </h4>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.description;
          })}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.memberUsageTotal;
          })}
        </p>
        <p className="mt-0.5 text-sm font-semibold text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            { price: formatUsd(usagePackTotalUsd, 0) },
          )}
        </p>
      </div>
    </div>
  );
}

function MemberUsageFooter() {
  return (
    <div className="border-t border-border/60 px-4 py-3">
      <p className="text-[11px] text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.memberExclusive;
        })}
      </p>
    </div>
  );
}

function MemberUsageConfiguration({
  catalog,
  members,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly members: readonly MemberDisplay[] | undefined;
}) {
  const selections = useGet(memberUsageSelections$);
  const setSelection = useSet(setMemberUsageSelection$);

  if (!members) {
    return <div className="h-36 animate-pulse rounded-xl bg-muted/40" />;
  }
  const { totalUsd } = memberUsageTotals(members, selections, catalog);
  const memberUsageLabel = i18n.t(($) => {
    return $.billing.plans.usagePacks.memberUsage;
  });

  return (
    <section
      role="group"
      aria-label={memberUsageLabel}
      className="rounded-xl bg-card zero-border"
    >
      <MemberUsageHeader usagePackTotalUsd={totalUsd} />

      {members.map((member, index) => {
        const selection = memberUsageSelection(selections, member.id);
        return (
          <div
            key={member.id}
            className={index === 0 ? undefined : "border-t border-border/50"}
          >
            <MemberUsageRow
              catalog={catalog}
              member={member}
              selection={selection}
              onSelect={(usage) => {
                setSelection({ memberId: member.id, usage });
              }}
            />
          </div>
        );
      })}

      <MemberUsageFooter />
    </section>
  );
}

function PlanFeatureList({ tier }: { readonly tier: UsagePackPlanTier }) {
  return (
    <ul className="my-6 flex flex-col gap-2.5">
      {planFeatures(tier).map((feature) => {
        return (
          <li key={feature} className="flex items-center gap-2">
            <Check size={14} className="shrink-0" />
            <span className="text-[13px] text-muted-foreground">{feature}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PlanSelectionCard({
  disabled,
  minimumPackagePriceUsd,
  onSelect,
  plan,
}: {
  readonly disabled: boolean;
  readonly minimumPackagePriceUsd: number;
  readonly onSelect: () => void;
  readonly plan: UsagePackPlan;
}) {
  const name = planName(plan.tier);
  const minimumTotalUsd = plan.basePriceUsd + minimumPackagePriceUsd;
  return (
    <article
      aria-label={i18n.t(
        ($) => {
          return $.billing.plans.namedPlan;
        },
        { plan: name },
      )}
      className="relative flex flex-col rounded-xl bg-card px-6 py-7 zero-border"
    >
      {plan.popular && (
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <Crown size={12} className="text-amber-500" />
          {i18n.t(($) => {
            return $.billing.plans.popular;
          })}
        </span>
      )}

      <img
        src={plan.image}
        alt=""
        loading="lazy"
        className="mb-2 h-20 w-20 object-contain"
      />
      <h3 className="text-base font-semibold text-foreground">{name}</h3>
      <p className="mt-1 min-h-[42px] text-[13px] leading-relaxed text-muted-foreground">
        {planDescription(plan.tier)}
      </p>

      <div className="mt-5">
        <p className="text-[12px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.startingAt;
          })}
        </p>
        <p className="mt-1 text-3xl font-light tracking-tight text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            { price: formatUsd(minimumTotalUsd, 0) },
          )}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.minimumPackageBreakdown;
            },
            {
              base: formatUsd(plan.basePriceUsd, 0),
              package: formatUsd(minimumPackagePriceUsd, 0),
            },
          )}
        </p>
      </div>

      <PlanFeatureList tier={plan.tier} />
      <Button
        type="button"
        className="mt-auto h-11 w-full text-sm font-medium"
        disabled={disabled}
        onClick={onSelect}
      >
        {i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.selectPlan;
          },
          { plan: name },
        )}
      </Button>
    </article>
  );
}

function PricingPageHeader({
  onBack,
  step,
}: {
  readonly onBack: () => void;
  readonly step: 1 | 2;
}) {
  const { t } = useTranslation();
  const title =
    step === 1
      ? t(($) => {
          return $.billing.plans.usagePacks.choosePlan;
        })
      : t(($) => {
          return $.billing.plans.usagePacks.configurePackages;
        });
  const description =
    step === 1
      ? t(($) => {
          return $.billing.plans.usagePacks.choosePlanDescription;
        })
      : t(($) => {
          return $.billing.plans.usagePacks.configurePackagesDescription;
        });
  return (
    <div className="flex items-center gap-3">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBack}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
              aria-label={t(($) => {
                return $.billing.common.back;
              })}
            >
              <ArrowLeft size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {t(($) => {
                return $.billing.common.back;
              })}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function PricingStep({
  active,
  label,
  number,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly number: number;
}) {
  return (
    <li
      aria-current={active ? "step" : undefined}
      className={`flex items-center gap-2 text-xs font-medium ${
        active ? "text-primary" : "text-muted-foreground"
      }`}
    >
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${
          active ? "bg-primary text-primary-foreground" : "zero-badge"
        }`}
      >
        {number}
      </span>
      {label}
    </li>
  );
}

function PricingSteps({ current }: { readonly current: 1 | 2 }) {
  return (
    <ol
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.purchaseSteps;
      })}
      className="flex items-center rounded-xl bg-muted/30 px-4 py-3 zero-border"
    >
      <PricingStep
        active={current === 1}
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.planStep;
        })}
        number={1}
      />
      <span className="mx-4 h-px flex-1 bg-border" aria-hidden="true" />
      <PricingStep
        active={current === 2}
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.packagesStep;
        })}
        number={2}
      />
    </ol>
  );
}

function SelectedPlanSummary({
  onChange,
  plan,
}: {
  readonly onChange: () => void;
  readonly plan: UsagePackPlan;
}) {
  const name = planName(plan.tier);
  return (
    <section className="flex items-center gap-4 rounded-xl bg-card px-4 py-3 zero-border">
      <img
        src={plan.image}
        alt=""
        className="h-12 w-12 shrink-0 object-contain"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.selectedPlan;
          })}
        </p>
        <p className="mt-0.5 text-sm font-medium text-foreground">{name}</p>
      </div>
      <p className="shrink-0 text-sm font-semibold text-foreground">
        {i18n.t(
          ($) => {
            return $.billing.plans.pricePerMonth;
          },
          { price: formatUsd(plan.basePriceUsd, 0) },
        )}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onChange}>
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.changePlan;
        })}
      </Button>
    </section>
  );
}

function OrderSummary({
  checkoutDisabled,
  checkoutError,
  checkoutLoading,
  memberUsageBonusCredits,
  memberUsageCredits,
  memberUsageTotalUsd,
  onCheckout,
  plan,
}: {
  readonly checkoutDisabled: boolean;
  readonly checkoutError: string | null;
  readonly checkoutLoading: boolean;
  readonly memberUsageBonusCredits: number;
  readonly memberUsageCredits: number;
  readonly memberUsageTotalUsd: number;
  readonly onCheckout: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly plan: UsagePackPlan;
}) {
  const totalUsd = plan.basePriceUsd + memberUsageTotalUsd;
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.orderSummary;
      })}
      className="rounded-xl bg-card p-4 zero-border"
    >
      <h4 className="text-sm font-medium text-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.orderSummary;
        })}
      </h4>
      <div className="mt-4 space-y-2.5 text-[13px]">
        <div className="flex items-center justify-between gap-4 text-muted-foreground">
          <span>
            {i18n.t(
              ($) => {
                return $.billing.plans.namedPlan;
              },
              { plan: planName(plan.tier) },
            )}
          </span>
          <span>{formatUsd(plan.basePriceUsd, 0)}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-muted-foreground">
          <span>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.memberPackages;
            })}
          </span>
          <span>{formatUsd(memberUsageTotalUsd, 0)}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-muted-foreground">
          <span>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.totalCredits;
            })}
          </span>
          <span>{formatLocalizedNumber(memberUsageCredits)}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-muted-foreground">
          <span>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.discountBonusCredits;
            })}
          </span>
          <span>{formatLocalizedNumber(memberUsageBonusCredits)}</span>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border pt-3 text-foreground">
          <span className="font-medium">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.monthlyTotal;
            })}
          </span>
          <span className="text-lg font-semibold">
            {i18n.t(
              ($) => {
                return $.billing.plans.pricePerMonth;
              },
              { price: formatUsd(totalUsd, 0) },
            )}
          </span>
        </div>
      </div>
      {checkoutError && (
        <p className="mt-3 text-xs text-destructive">{checkoutError}</p>
      )}
      <Button
        className="mt-4 h-10 w-full text-sm font-medium"
        disabled={checkoutDisabled || checkoutLoading}
        onClick={onCheckout}
      >
        {checkoutLoading
          ? i18n.t(($) => {
              return $.billing.common.redirecting;
            })
          : i18n.t(
              ($) => {
                return $.billing.plans.upgradeTo;
              },
              { plan: planName(plan.tier) },
            )}
      </Button>
    </section>
  );
}

function CheckoutOrderSummary({
  members,
  plan,
  selections,
  totals,
}: {
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startUsagePackCheckout$);
  const checkoutLoading = checkoutLoadable.state === "loading";
  const checkoutError =
    checkoutLoadable.state === "hasError"
      ? String(checkoutLoadable.error)
      : null;

  return (
    <OrderSummary
      checkoutDisabled={!members}
      checkoutError={checkoutError}
      checkoutLoading={checkoutLoading}
      memberUsageBonusCredits={totals.bonusCredits}
      memberUsageCredits={totals.totalCredits}
      memberUsageTotalUsd={totals.totalUsd}
      onCheckout={(event) => {
        if (!members) {
          return;
        }
        detach(
          checkout(
            {
              tier: plan.tier,
              memberUsagePacks: checkoutMemberUsagePacks(members, selections),
            },
            event.metaKey || event.ctrlKey,
            pageSignal,
          ),
          Reason.DomCallback,
        );
      }}
      plan={plan}
    />
  );
}

function PlanSelectionStep({
  catalog,
  currentTier,
  onBack,
  onSelect,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly currentTier: BillingTier;
  readonly onBack: () => void;
  readonly onSelect: (plan: UsagePackPlanTier) => void;
}) {
  const minimumPackage = usagePackCatalogItem(catalog, MINIMUM_USAGE_PACK_USD);
  return (
    <>
      <PricingPageHeader onBack={onBack} step={1} />
      <PricingSteps current={1} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {USAGE_PACK_PLANS.map((plan) => {
          return (
            <PlanSelectionCard
              key={plan.tier}
              disabled={!canCheckoutUsagePackPlan(currentTier, plan.tier)}
              minimumPackagePriceUsd={minimumPackage.priceUsd}
              plan={plan}
              onSelect={() => {
                onSelect(plan.tier);
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function PackageConfigurationStep({
  catalog,
  onBack,
  plan,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly onBack: () => void;
  readonly plan: UsagePackPlan;
}) {
  const userLoadable = useLastLoadable(currentUserInfo$);
  const membersLoadable = useLoadable(orgMembers$);
  const pendingInvitationsLoadable = useLoadable(orgPendingInvitations$);
  const selections = useGet(memberUsageSelections$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const orgMembers =
    membersLoadable.state === "hasData" ? membersLoadable.data : undefined;
  const pendingInvitations =
    pendingInvitationsLoadable.state === "hasData"
      ? pendingInvitationsLoadable.data
      : undefined;
  const members: readonly MemberDisplay[] | undefined =
    user && orgMembers && pendingInvitations
      ? [
          {
            id: user.id,
            email: user.primaryEmailAddress?.emailAddress,
            imageUrl: user.imageUrl,
            isCurrent: true,
            isPending: false,
            name:
              user.fullName ??
              user.primaryEmailAddress?.emailAddress ??
              i18n.t(($) => {
                return $.billing.plans.usagePacks.currentMember;
              }),
          },
          ...orgMembers
            .filter((member) => {
              return member.userId !== user.id;
            })
            .map((member): MemberDisplay => {
              return {
                id: member.userId,
                email: member.email,
                imageUrl: member.imageUrl,
                isCurrent: false,
                isPending: false,
                name: memberName(member),
              };
            }),
          ...pendingInvitations.map((invitation): MemberDisplay => {
            return {
              id: invitation.id,
              email: invitation.email,
              imageUrl: undefined,
              isCurrent: false,
              isPending: true,
              name: invitation.email,
            };
          }),
        ]
      : undefined;
  const totals = memberUsageTotals(members ?? [], selections, catalog);

  return (
    <>
      <PricingPageHeader onBack={onBack} step={2} />
      <PricingSteps current={2} />
      <SelectedPlanSummary plan={plan} onChange={onBack} />
      <MemberUsageConfiguration catalog={catalog} members={members} />
      <CheckoutOrderSummary
        members={members}
        plan={plan}
        selections={selections}
        totals={totals}
      />
    </>
  );
}

export function UsagePackPricingPage({
  currentTier,
  onBack,
}: {
  readonly currentTier: BillingTier;
  readonly onBack: () => void;
}) {
  const selectedPlanTier = useGet(selectedUsagePackPlan$);
  const setSelectedPlan = useSet(setSelectedUsagePackPlan$);
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const selectedPlan = USAGE_PACK_PLANS.find((plan) => {
    return (
      plan.tier === selectedPlanTier &&
      canCheckoutUsagePackPlan(currentTier, plan.tier)
    );
  });
  return (
    <div
      className="flex flex-col gap-5 outline-none"
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      {!catalog ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : selectedPlan ? (
        <PackageConfigurationStep
          catalog={catalog}
          plan={selectedPlan}
          onBack={() => {
            setSelectedPlan(null);
          }}
        />
      ) : (
        <PlanSelectionStep
          catalog={catalog}
          currentTier={currentTier}
          onBack={() => {
            setSelectedPlan(null);
            onBack();
          }}
          onSelect={setSelectedPlan}
        />
      )}
    </div>
  );
}
