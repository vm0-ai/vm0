import { ArrowLeft, Check, Crown, User } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  UsagePackManagementResponse,
  UsagePackSubscriptionChangePreviewResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { currentUserInfo$ } from "../../../../signals/auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeUsagePackSubscriptionChangePreview$,
  confirmUsagePackSubscriptionChange$,
  previewUsagePackSubscriptionChange$,
  startUsagePackCheckout$,
  type BillingTier,
  usagePackCatalogAsync$,
  usagePackManagementAsync$,
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
  setMemberUsageSelections$,
  setSelectedUsagePackPlan$,
  USAGE_PACKS_USD,
  usagePackSubscriptionChangePreview$,
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

interface MemberUsageDowngrade {
  readonly effectiveAt: string | null;
  readonly targetUsagePackUsd: UsagePackUsd;
}

type PlanSelectionAction =
  | "disabled"
  | "downgrade"
  | "manage"
  | "select"
  | "upgrade";

const USAGE_PACK_PLANS = [
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
] as const satisfies readonly UsagePackPlan[];

function usagePackPlan(tier: UsagePackPlanTier): UsagePackPlan {
  return tier === "pro" ? USAGE_PACK_PLANS[0] : USAGE_PACK_PLANS[1];
}

function canCheckoutUsagePackPlan(
  currentTier: BillingTier,
  targetTier: UsagePackPlanTier,
): boolean {
  if (currentTier === "custom" || currentTier === "team") {
    return false;
  }
  return currentTier !== "pro" || targetTier === "team";
}

function usagePackPlanAction(
  currentTier: BillingTier,
  managedTier: UsagePackPlanTier | null,
  targetTier: UsagePackPlanTier,
): PlanSelectionAction {
  if (managedTier === targetTier) {
    return "manage";
  }
  if (managedTier === "pro" && targetTier === "team") {
    return "upgrade";
  }
  if (managedTier === "team" && targetTier === "pro") {
    return "downgrade";
  }
  return canCheckoutUsagePackPlan(currentTier, targetTier)
    ? "select"
    : "disabled";
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

function formatBillingDate(value: string): string {
  return new Date(value).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
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
      return $.billing.plans.features.sharedAndPrivateAgents;
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

type ManagedUsagePackAllocation =
  UsagePackManagementResponse["allocations"][number];

function managedUsagePackSelection(
  allocation: ManagedUsagePackAllocation,
): UsagePackUsd {
  const pendingChange = allocation.pendingChange;
  return pendingChange?.kind === "downgrade" &&
    pendingChange.status === "scheduled" &&
    pendingChange.targetUsagePackUsd !== null
    ? pendingChange.targetUsagePackUsd
    : allocation.usagePackUsd;
}

function managedMemberUsageTotals(
  management: UsagePackManagementResponse,
  catalog: readonly UsagePackCatalogItem[],
): MemberUsageTotals {
  return management.allocations.reduce<MemberUsageTotals>(
    (totals, allocation) => {
      const item = usagePackCatalogItem(
        catalog,
        managedUsagePackSelection(allocation),
      );
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
  downgrade,
  member,
  onSelect,
  selection,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly downgrade: MemberUsageDowngrade | null;
  readonly member: MemberDisplay;
  readonly onSelect: (selection: MemberUsageSelection) => void;
  readonly selection: MemberUsageSelection;
}) {
  const item = usagePackCatalogItem(catalog, selection);
  const creditBreakdown = i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.creditBreakdown;
    },
    {
      bonus: formatLocalizedNumber(item.bonusCredits),
      purchased: formatLocalizedNumber(item.purchasedCredits),
    },
  );
  const downgradeSummary = downgrade
    ? downgrade.effectiveAt
      ? i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.management.downgradesToDate;
          },
          {
            package: formatUsd(downgrade.targetUsagePackUsd, 0),
            date: formatBillingDate(downgrade.effectiveAt),
          },
        )
      : i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.management.downgradesToPeriod;
          },
          {
            package: formatUsd(downgrade.targetUsagePackUsd, 0),
          },
        )
    : null;
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
        <p
          className={`mt-1 truncate text-[10px] ${downgradeSummary ? "font-medium text-amber-600 dark:text-amber-300" : "text-muted-foreground"}`}
        >
          {downgradeSummary ?? creditBreakdown}
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
  management,
  members,
  onSelectionChange,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly management: UsagePackManagementResponse | null;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly onSelectionChange?: () => void;
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
        const allocation = management?.allocations.find((candidate) => {
          return candidate.memberId === member.id;
        });
        const pendingDowngrade =
          allocation?.pendingChange?.kind === "downgrade" &&
          allocation.pendingChange.targetUsagePackUsd !== null
            ? {
                effectiveAt:
                  allocation.pendingChange.effectiveAt ??
                  allocation.currentPeriodEnd ??
                  management?.currentPeriodEnd ??
                  null,
                targetUsagePackUsd: allocation.pendingChange.targetUsagePackUsd,
              }
            : null;
        const downgrade =
          pendingDowngrade ??
          (allocation && selection < allocation.usagePackUsd
            ? {
                effectiveAt:
                  allocation.currentPeriodEnd ??
                  management?.currentPeriodEnd ??
                  null,
                targetUsagePackUsd: selection,
              }
            : null);
        return (
          <div
            key={member.id}
            className={index === 0 ? undefined : "border-t border-border/50"}
          >
            <MemberUsageRow
              catalog={catalog}
              downgrade={downgrade}
              member={member}
              selection={selection}
              onSelect={(usage) => {
                setSelection({ memberId: member.id, usage });
                onSelectionChange?.();
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
  action,
  busy,
  keepsMemberPackages,
  minimumPackagePriceUsd,
  onAction,
  plan,
}: {
  readonly action: PlanSelectionAction;
  readonly busy: boolean;
  readonly keepsMemberPackages: boolean;
  readonly minimumPackagePriceUsd: number;
  readonly onAction: () => void;
  readonly plan: UsagePackPlan;
}) {
  const name = planName(plan.tier);
  const displayedPriceUsd = plan.basePriceUsd + minimumPackagePriceUsd;
  const actionLabel =
    action === "manage"
      ? i18n.t(($) => {
          return $.billing.common.manage;
        })
      : action === "upgrade"
        ? i18n.t(($) => {
            return $.billing.plans.upgrade;
          })
        : action === "downgrade"
          ? i18n.t(($) => {
              return $.billing.plans.downgrade;
            })
          : i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.selectPlan;
              },
              { plan: name },
            );
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
            { price: formatUsd(displayedPriceUsd, 0) },
          )}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {keepsMemberPackages
            ? i18n.t(($) => {
                return $.billing.plans.usagePacks.existingPackagesUnchanged;
              })
            : i18n.t(
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
        disabled={action === "disabled" || busy}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </article>
  );
}

function UsagePackPageHeader({
  description,
  onBack,
  title,
}: {
  readonly description: string;
  readonly onBack: () => void;
  readonly title: string;
}) {
  const { t } = useTranslation();
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

function PricingPageHeader({
  onBack,
  step,
}: {
  readonly onBack: () => void;
  readonly step: 1 | 2;
}) {
  const { t } = useTranslation();
  return (
    <UsagePackPageHeader
      onBack={onBack}
      title={
        step === 1
          ? t(($) => {
              return $.billing.plans.usagePacks.choosePlan;
            })
          : t(($) => {
              return $.billing.plans.usagePacks.configurePackages;
            })
      }
      description={
        step === 1
          ? t(($) => {
              return $.billing.plans.usagePacks.choosePlanDescription;
            })
          : t(($) => {
              return $.billing.plans.usagePacks.configurePackagesDescription;
            })
      }
    />
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
  error,
  loading,
  managedTier,
  onBack,
  onAction,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly currentTier: BillingTier;
  readonly error: string | null;
  readonly loading: boolean;
  readonly managedTier: UsagePackPlanTier | null;
  readonly onBack: () => void;
  readonly onAction: (
    plan: UsagePackPlanTier,
    action: PlanSelectionAction,
  ) => void;
}) {
  const minimumPackage = usagePackCatalogItem(catalog, MINIMUM_USAGE_PACK_USD);
  return (
    <>
      <PricingPageHeader onBack={onBack} step={1} />
      <PricingSteps current={1} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {USAGE_PACK_PLANS.map((plan) => {
          const action = usagePackPlanAction(
            currentTier,
            managedTier,
            plan.tier,
          );
          return (
            <PlanSelectionCard
              key={plan.tier}
              action={action}
              busy={loading}
              keepsMemberPackages={managedTier !== null}
              minimumPackagePriceUsd={minimumPackage.priceUsd}
              plan={plan}
              onAction={() => {
                onAction(plan.tier, action);
              }}
            />
          );
        })}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

function ManagedSubscriptionSummaryDetails({
  plan,
  totals,
}: {
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
}) {
  const monthlyTotalUsd = plan.basePriceUsd + totals.totalUsd;
  return (
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
        <span>{formatUsd(totals.totalUsd, 0)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.totalCredits;
          })}
        </span>
        <span>{formatLocalizedNumber(totals.totalCredits)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.discountBonusCredits;
          })}
        </span>
        <span>{formatLocalizedNumber(totals.bonusCredits)}</span>
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
            { price: formatUsd(monthlyTotalUsd, 0) },
          )}
        </span>
      </div>
    </div>
  );
}

function ManagedSubscriptionComparison({
  currentTotals,
  management,
  plan,
  totals,
}: {
  readonly currentTotals: MemberUsageTotals;
  readonly management: UsagePackManagementResponse;
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
}) {
  const currentPlan = usagePackPlan(management.tier);
  const currentMonthlyTotalUsd =
    currentPlan.basePriceUsd + currentTotals.totalUsd;
  const nextMonthlyTotalUsd = plan.basePriceUsd + totals.totalUsd;
  const rows = [
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.planStep;
      }),
      current: `${planName(currentPlan.tier)} · ${formatUsd(currentPlan.basePriceUsd, 0)}`,
      next: `${planName(plan.tier)} · ${formatUsd(plan.basePriceUsd, 0)}`,
      changed: currentPlan.tier !== plan.tier,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.memberPackages;
      }),
      current: formatUsd(currentTotals.totalUsd, 0),
      next: formatUsd(totals.totalUsd, 0),
      changed: currentTotals.totalUsd !== totals.totalUsd,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.totalCredits;
      }),
      current: formatLocalizedNumber(currentTotals.totalCredits),
      next: formatLocalizedNumber(totals.totalCredits),
      changed: currentTotals.totalCredits !== totals.totalCredits,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.discountBonusCredits;
      }),
      current: formatLocalizedNumber(currentTotals.bonusCredits),
      next: formatLocalizedNumber(totals.bonusCredits),
      changed: currentTotals.bonusCredits !== totals.bonusCredits,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.monthlyTotal;
      }),
      current: i18n.t(
        ($) => {
          return $.billing.plans.pricePerMonth;
        },
        { price: formatUsd(currentMonthlyTotalUsd, 0) },
      ),
      next: i18n.t(
        ($) => {
          return $.billing.plans.pricePerMonth;
        },
        { price: formatUsd(nextMonthlyTotalUsd, 0) },
      ),
      changed: currentMonthlyTotalUsd !== nextMonthlyTotalUsd,
    },
  ];

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border/70">
      <table
        aria-label={i18n.t(($) => {
          return $.billing.plans.usagePacks.management.comparison;
        })}
        className="w-full table-fixed text-[13px]"
      >
        <thead className="bg-muted/40 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="w-[40%] px-3 py-2 text-left" />
            <th scope="col" className="w-[30%] px-3 py-2 text-right">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.current;
              })}
            </th>
            <th scope="col" className="w-[30%] px-3 py-2 text-right">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.new;
              })}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const monthlyTotal = index === rows.length - 1;
            return (
              <tr
                key={row.label}
                className={`border-t border-border/60 ${monthlyTotal ? "bg-muted/20" : ""}`}
              >
                <th
                  scope="row"
                  className={`px-3 py-2.5 text-left ${monthlyTotal ? "font-medium text-foreground" : "font-normal text-muted-foreground"}`}
                >
                  {row.label}
                </th>
                <td
                  className={`px-3 py-2.5 text-right text-muted-foreground ${monthlyTotal ? "font-medium" : ""}`}
                >
                  {row.current}
                </td>
                <td
                  className={`px-3 py-2.5 text-right ${row.changed ? "font-semibold text-primary" : "font-medium text-foreground"}`}
                >
                  {row.next}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManagedSubscriptionDowngradeNotice({
  currentPeriodEnd,
}: {
  readonly currentPeriodEnd: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300">
      <p>
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.management.downgradeDescription;
        })}
      </p>
      <p className="mt-1 font-medium">
        {i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.management.scheduledFor;
          },
          { date: formatBillingDate(currentPeriodEnd) },
        )}
      </p>
    </div>
  );
}

function UsagePackSubscriptionChangeDialog({
  confirming,
  error,
  onCancel,
  onConfirm,
  plan,
  preview,
  totals,
}: {
  readonly confirming: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly plan: UsagePackPlan;
  readonly preview: UsagePackSubscriptionChangePreviewResponse | null;
  readonly totals: MemberUsageTotals;
}) {
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management.reviewTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management.reviewDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <ManagedSubscriptionSummaryDetails plan={plan} totals={totals} />
        {preview && (
          <div className="mt-2 space-y-2.5 rounded-lg bg-muted/50 p-3 text-[13px]">
            <div className="flex items-center justify-between gap-4 text-muted-foreground">
              <span>
                {i18n.t(($) => {
                  return $.billing.plans.usagePacks.management.immediateAmount;
                })}
              </span>
              <span className="font-medium text-foreground">
                {formatUsd(preview.immediateAmountCents / 100)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 text-muted-foreground">
              <span>
                {i18n.t(($) => {
                  return $.billing.plans.usagePacks.management.nextRecurring;
                })}
              </span>
              <span className="font-medium text-foreground">
                {formatUsd(preview.nextRecurringAmountCents / 100)}
              </span>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={confirming}
            onClick={onCancel}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button type="button" disabled={confirming} onClick={onConfirm}>
            {confirming
              ? i18n.t(($) => {
                  return $.billing.common.updating;
                })
              : i18n.t(($) => {
                  return $.billing.common.confirm;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ManagedSubscriptionOrderSummaryProps {
  readonly currentTotals: MemberUsageTotals;
  readonly management: UsagePackManagementResponse;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
}

function hasPendingUsagePackChange(
  management: UsagePackManagementResponse,
): boolean {
  return management.allocations.some((allocation) => {
    return allocation.pendingChange !== null;
  });
}

function hasRestorableUsagePackDowngrade(
  management: UsagePackManagementResponse,
): boolean {
  const pendingChanges = management.allocations.flatMap((allocation) => {
    return allocation.pendingChange ? [allocation.pendingChange] : [];
  });
  return (
    pendingChanges.length > 0 &&
    pendingChanges.every((change) => {
      return change.kind === "downgrade" && change.status === "scheduled";
    })
  );
}

function hasUsagePackConfigurationChange(
  management: UsagePackManagementResponse,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  return (
    management.tier !== plan.tier ||
    management.allocations.some((allocation) => {
      return (
        memberUsageSelection(selections, allocation.memberId) !==
        managedUsagePackSelection(allocation)
      );
    })
  );
}

function restoresScheduledUsagePackDowngrade(
  management: UsagePackManagementResponse,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  return (
    management.tier === plan.tier &&
    hasRestorableUsagePackDowngrade(management) &&
    management.allocations.every((allocation) => {
      return (
        memberUsageSelection(selections, allocation.memberId) ===
        allocation.usagePackUsd
      );
    })
  );
}

function hasUsagePackDowngrade(
  management: UsagePackManagementResponse,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  return (
    (management.tier === "team" && plan.tier === "pro") ||
    management.allocations.some((allocation) => {
      return (
        memberUsageSelection(selections, allocation.memberId) <
        allocation.usagePackUsd
      );
    })
  );
}

function managedSubscriptionActionLabel(args: {
  readonly hasConfigurationChange: boolean;
  readonly previewing: boolean;
  readonly restoresScheduledDowngrade: boolean;
}): string {
  if (args.previewing) {
    return i18n.t(($) => {
      return $.billing.common.updating;
    });
  }
  if (args.restoresScheduledDowngrade) {
    return i18n.t(($) => {
      return $.billing.common.restore;
    });
  }
  return args.hasConfigurationChange
    ? i18n.t(($) => {
        return $.billing.common.confirm;
      })
    : i18n.t(($) => {
        return $.billing.plans.currentPlan;
      });
}

function ManagedSubscriptionOrderSummary({
  currentTotals,
  management,
  members,
  plan,
  selections,
  totals,
}: ManagedSubscriptionOrderSummaryProps) {
  const pageSignal = useGet(pageSignal$);
  const preview = useGet(usagePackSubscriptionChangePreview$);
  const closePreview = useSet(closeUsagePackSubscriptionChangePreview$);
  const [previewLoadable, previewChange] = useLoadableSet(
    previewUsagePackSubscriptionChange$,
  );
  const [confirmationLoadable, confirmChange] = useLoadableSet(
    confirmUsagePackSubscriptionChange$,
  );
  const previewing = previewLoadable.state === "loading";
  const confirming = confirmationLoadable.state === "loading";
  const error =
    previewLoadable.state === "hasError" ||
    confirmationLoadable.state === "hasError"
      ? i18n.t(($) => {
          return $.billing.plans.usagePacks.planChangeError;
        })
      : null;
  const hasPendingChange = hasPendingUsagePackChange(management);
  const hasConfigurationChange = hasUsagePackConfigurationChange(
    management,
    plan,
    selections,
  );
  const hasScheduledDowngrade = hasRestorableUsagePackDowngrade(management);
  const restoresScheduledDowngrade = restoresScheduledUsagePackDowngrade(
    management,
    plan,
    selections,
  );
  const hasDowngrade = hasUsagePackDowngrade(management, plan, selections);
  const openPreview = async (): Promise<void> => {
    if (!members) {
      return;
    }
    await previewChange(
      {
        targetTier: plan.tier,
        memberUsagePacks: checkoutMemberUsagePacks(members, selections),
      },
      pageSignal,
    );
  };
  const submitChange = async (): Promise<void> => {
    await confirmChange(pageSignal);
  };

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
      {hasConfigurationChange ? (
        <ManagedSubscriptionComparison
          currentTotals={currentTotals}
          management={management}
          plan={plan}
          totals={totals}
        />
      ) : (
        <ManagedSubscriptionSummaryDetails plan={plan} totals={totals} />
      )}
      {hasDowngrade && management.currentPeriodEnd && (
        <ManagedSubscriptionDowngradeNotice
          currentPeriodEnd={management.currentPeriodEnd}
        />
      )}
      {hasPendingChange && !hasScheduledDowngrade && (
        <p className="mt-3 text-xs text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.processing;
          })}
        </p>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <Button
        type="button"
        className="mt-4 h-10 w-full text-sm font-medium"
        disabled={
          !members ||
          (hasPendingChange && !restoresScheduledDowngrade) ||
          (!hasConfigurationChange && !restoresScheduledDowngrade) ||
          previewing ||
          confirming
        }
        onClick={() => {
          detach(openPreview(), Reason.DomCallback);
        }}
      >
        {managedSubscriptionActionLabel({
          hasConfigurationChange,
          previewing,
          restoresScheduledDowngrade,
        })}
      </Button>
      <UsagePackSubscriptionChangeDialog
        confirming={confirming}
        error={error}
        onCancel={closePreview}
        onConfirm={() => {
          detach(submitChange(), Reason.DomCallback);
        }}
        plan={plan}
        preview={preview}
        totals={totals}
      />
    </section>
  );
}

function PackageConfigurationStep({
  catalog,
  management,
  onBack,
  plan,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly management: UsagePackManagementResponse | null;
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
  const allMembers: readonly MemberDisplay[] | undefined =
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
  const members = management
    ? allMembers
      ? management.allocations.map((allocation): MemberDisplay => {
          return (
            allMembers.find((member) => {
              return member.id === allocation.memberId;
            }) ?? {
              id: allocation.memberId,
              email: undefined,
              imageUrl: undefined,
              isCurrent: allocation.memberId === user?.id,
              isPending: false,
              name: allocation.memberId,
            }
          );
        })
      : undefined
    : allMembers;
  const totals = memberUsageTotals(members ?? [], selections, catalog);

  return (
    <>
      <PricingPageHeader onBack={onBack} step={2} />
      <PricingSteps current={2} />
      <SelectedPlanSummary plan={plan} onChange={onBack} />
      <MemberUsageConfiguration
        catalog={catalog}
        management={management}
        members={members}
      />
      {management ? (
        <ManagedSubscriptionOrderSummary
          currentTotals={managedMemberUsageTotals(management, catalog)}
          management={management}
          members={members}
          plan={plan}
          selections={selections}
          totals={totals}
        />
      ) : (
        <CheckoutOrderSummary
          members={members}
          plan={plan}
          selections={selections}
          totals={totals}
        />
      )}
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
  const setMemberUsageSelections = useSet(setMemberUsageSelections$);
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const managementLoadable = useLoadable(usagePackManagementAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const management =
    managementLoadable.state === "hasData" ? managementLoadable.data : null;
  const managementLoaded =
    (currentTier !== "pro" && currentTier !== "team") ||
    managementLoadable.state === "hasData";
  const selectedPlan = USAGE_PACK_PLANS.find((plan) => {
    return (
      plan.tier === selectedPlanTier &&
      (management !== null || canCheckoutUsagePackPlan(currentTier, plan.tier))
    );
  });
  return (
    <div
      className="flex flex-col gap-5 outline-none"
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      {!catalog || !managementLoaded ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : selectedPlan ? (
        <PackageConfigurationStep
          catalog={catalog}
          management={management}
          plan={selectedPlan}
          onBack={() => {
            setSelectedPlan(null);
          }}
        />
      ) : (
        <PlanSelectionStep
          catalog={catalog}
          currentTier={currentTier}
          error={null}
          loading={false}
          managedTier={management?.tier ?? null}
          onBack={() => {
            setSelectedPlan(null);
            onBack();
          }}
          onAction={(plan, action) => {
            if (action === "disabled") {
              return;
            }
            setMemberUsageSelections(
              management
                ? Object.fromEntries(
                    management.allocations.map((allocation) => {
                      return [
                        allocation.memberId,
                        managedUsagePackSelection(allocation),
                      ] as const;
                    }),
                  )
                : {},
            );
            setSelectedPlan(plan);
          }}
        />
      )}
    </div>
  );
}
