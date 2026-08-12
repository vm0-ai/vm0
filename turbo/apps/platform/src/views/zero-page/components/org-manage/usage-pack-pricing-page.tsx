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
  UsagePackMigrationConfiguration,
  UsagePackSubscriptionChangePreviewResponse,
  UsagePackMigrationPreviewResponse,
  UsagePackMigrationRevisionPreviewResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { currentUserInfo$ } from "../../../../signals/auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeUsagePackSubscriptionChangePreview$,
  confirmUsagePackSubscriptionChange$,
  previewUsagePackSubscriptionChange$,
  confirmUsagePackMigration$,
  confirmUsagePackMigrationRevision$,
  previewUsagePackMigrationRevision$,
  previewUsagePackMigration$,
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
  managedUsagePackSelection,
  memberUsageSelections$,
  MINIMUM_USAGE_PACK_USD,
  selectedUsagePackPlan$,
  setMemberUsageSelection$,
  setMemberUsageSelections$,
  setSelectedUsagePackPlan$,
  usagePackSubscriptionChangePreview$,
  usagePackPricingPageRef$,
  closeUsagePackMigrationPreview$,
  closeUsagePackMigrationRevisionPreview$,
  usagePackMigrationPreview$,
  usagePackMigrationRevisionPreview$,
  type MemberUsageSelection,
  type UsagePackPlanTier,
  type UsagePackUsd,
} from "../../../../signals/zero-page/settings/usage-pack-pricing-state.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { planProImg, planTeamImg } from "../../platform-assets.ts";
import {
  parseUsagePackOption,
  usagePackOptionLabel,
} from "./usage-pack-options.ts";

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
  readonly usagePackUsd?: UsagePackUsd;
}

interface MemberUsageDowngrade {
  readonly effectiveAt: string | null;
  readonly targetUsagePackUsd: UsagePackUsd;
}

type PlanSelectionAction =
  | "convert"
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
  checkoutAllowed: boolean,
  currentTier: BillingTier,
  targetTier: UsagePackPlanTier,
): boolean {
  if (!checkoutAllowed || currentTier === "custom" || currentTier === "team") {
    return false;
  }
  return currentTier !== "pro" || targetTier === "team";
}

function usagePackPlanAction(
  checkoutAllowed: boolean,
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
  return canCheckoutUsagePackPlan(checkoutAllowed, currentTier, targetTier)
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

function planConcurrentSlots(tier: UsagePackPlanTier): number {
  return tier === "pro" ? 2 : 10;
}

function legacyPlanMonthlyCredits(tier: UsagePackPlanTier): number {
  return tier === "pro" ? 20_000 : 120_000;
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
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.voiceInputPro;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.voiceInputTeam;
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

function migrationConfigurationSelections(
  configuration: UsagePackMigrationConfiguration,
): Readonly<Record<string, MemberUsageSelection>> {
  return Object.fromEntries(
    configuration.memberUsagePacks.map((selection) => {
      return [selection.memberId, selection.usagePackUsd] as const;
    }),
  );
}

function migrationConfigurationTotals(
  configuration: UsagePackMigrationConfiguration,
  catalog: readonly UsagePackCatalogItem[],
): MemberUsageTotals {
  return configuration.memberUsagePacks.reduce<MemberUsageTotals>(
    (totals, selection) => {
      const item = usagePackCatalogItem(catalog, selection.usagePackUsd);
      return {
        bonusCredits: totals.bonusCredits + item.bonusCredits,
        totalCredits: totals.totalCredits + item.totalCredits,
        totalUsd: totals.totalUsd + item.priceUsd,
      };
    },
    { bonusCredits: 0, totalCredits: 0, totalUsd: 0 },
  );
}

function migrationConfigurationChanged(
  configuration: UsagePackMigrationConfiguration,
  targetTier: UsagePackPlanTier,
  requested: readonly MemberUsagePack[],
): boolean {
  if (
    configuration.tier !== targetTier ||
    configuration.memberUsagePacks.length !== requested.length
  ) {
    return true;
  }
  const currentByMember = new Map(
    configuration.memberUsagePacks.map((selection) => {
      return [selection.memberId, selection.usagePackUsd] as const;
    }),
  );
  return requested.some((selection) => {
    return currentByMember.get(selection.memberId) !== selection.usagePackUsd;
  });
}

function managedMemberUsageTotals(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[] | undefined,
  catalog: readonly UsagePackCatalogItem[],
): MemberUsageTotals {
  const allocations = members
    ? managedAllocationsForMembers(management, members)
    : management.allocations;
  return allocations.reduce<MemberUsageTotals>(
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
  disabled = false,
  downgrade,
  member,
  onSelect,
  selection,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly disabled?: boolean;
  readonly downgrade: MemberUsageDowngrade | null;
  readonly member: MemberDisplay;
  readonly onSelect: (selection: MemberUsageSelection) => void;
  readonly selection: MemberUsageSelection;
}) {
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
          disabled={disabled}
          value={String(selection)}
          onValueChange={(value) => {
            onSelect(parseUsagePackOption(value, catalog));
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
          <SelectContent className="w-max max-w-[calc(100vw-2rem)]">
            {catalog.map((pack) => {
              return (
                <SelectItem
                  key={pack.usagePackUsd}
                  value={String(pack.usagePackUsd)}
                  className="whitespace-nowrap"
                >
                  {usagePackOptionLabel(pack)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {downgradeSummary && (
          <p className="mt-1 truncate text-[10px] font-medium text-amber-600 dark:text-amber-300">
            {downgradeSummary}
          </p>
        )}
      </div>
    </div>
  );
}

function MemberUsageHeader() {
  return (
    <div className="border-b border-border/60 px-4 py-4">
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

function pendingMemberUsagePack(
  management: UsagePackManagementResponse | null,
  member: MemberDisplay,
): UsagePackUsd | null {
  if (management === null || !member.isPending) {
    return null;
  }
  return member.usagePackUsd ?? null;
}

function MemberUsageConfiguration({
  catalog,
  management,
  members,
  onSelectionChange,
  pendingMembers = [],
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly management: UsagePackManagementResponse | null;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly onSelectionChange?: () => void;
  readonly pendingMembers?: readonly MemberDisplay[];
}) {
  const selections = useGet(memberUsageSelections$);
  const setSelection = useSet(setMemberUsageSelection$);

  if (!members) {
    return <div className="h-36 animate-pulse rounded-xl bg-muted/40" />;
  }
  const memberUsageLabel = i18n.t(($) => {
    return $.billing.plans.usagePacks.memberUsage;
  });
  const displayedMembers = [...members, ...pendingMembers];

  return (
    <section
      role="group"
      aria-label={memberUsageLabel}
      className="rounded-xl bg-card zero-border"
    >
      <MemberUsageHeader />

      {displayedMembers.map((member, index) => {
        const pendingUsagePack = pendingMemberUsagePack(management, member);
        const selection =
          pendingUsagePack ?? memberUsageSelection(selections, member.id);
        const allocation = management?.allocations.find((candidate) => {
          return candidate.memberId === member.id;
        });
        const pendingDowngrade =
          allocation?.pendingChange?.kind === "downgrade" &&
          allocation.pendingChange.status !== "previewed" &&
          allocation.pendingChange.targetUsagePackUsd !== null &&
          selection === allocation.pendingChange.targetUsagePackUsd
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
              disabled={pendingUsagePack !== null}
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
    action === "convert"
      ? i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.convertPlan;
        })
      : action === "manage"
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
            <Button
              type="button"
              onClick={onBack}
              variant="quiet"
              size="icon-xs"
              aria-label={t(($) => {
                return $.billing.common.back;
              })}
            >
              <ArrowLeft size={16} />
            </Button>
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
  readonly onChange?: () => void;
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
      {onChange && (
        <Button type="button" variant="outline" size="sm" onClick={onChange}>
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.changePlan;
          })}
        </Button>
      )}
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
              return $.billing.plans.usagePacks.concurrentSlots;
            })}
          </span>
          <span>{formatLocalizedNumber(planConcurrentSlots(plan.tier))}</span>
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
          <span className="font-semibold">
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
  checkoutAllowed,
  currentTier,
  error,
  loading,
  managedTier,
  onBack,
  onAction,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly checkoutAllowed: boolean;
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
            checkoutAllowed,
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

function useUsagePackMembers(): readonly MemberDisplay[] | undefined {
  const userLoadable = useLastLoadable(currentUserInfo$);
  const membersLoadable = useLoadable(orgMembers$);
  const pendingInvitationsLoadable = useLoadable(orgPendingInvitations$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const orgMembers =
    membersLoadable.state === "hasData" ? membersLoadable.data : undefined;
  const pendingInvitations =
    pendingInvitationsLoadable.state === "hasData"
      ? pendingInvitationsLoadable.data
      : undefined;
  if (!user || !orgMembers || !pendingInvitations) {
    return undefined;
  }
  return [
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
        ...(invitation.usagePackUsd === undefined
          ? {}
          : { usagePackUsd: invitation.usagePackUsd }),
      };
    }),
  ];
}

function ManagedSubscriptionSummaryDetails({
  monthlyTotalCents,
  plan,
  totals,
}: {
  readonly monthlyTotalCents?: number;
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
}) {
  const monthlyTotalUsd =
    monthlyTotalCents === undefined
      ? plan.basePriceUsd + totals.totalUsd
      : monthlyTotalCents / 100;
  const monthlyTotalFractionDigits = Number.isInteger(monthlyTotalUsd) ? 0 : 2;
  const purchasedCredits = totals.totalCredits - totals.bonusCredits;
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
            return $.billing.plans.usagePacks.concurrentSlots;
          })}
        </span>
        <span>{formatLocalizedNumber(planConcurrentSlots(plan.tier))}</span>
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
            return $.billing.plans.usagePacks.purchasedCredits;
          })}
        </span>
        <span>{formatLocalizedNumber(purchasedCredits)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.bonusCredits;
          })}
        </span>
        <span>{formatLocalizedNumber(totals.bonusCredits)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border pt-3 text-foreground">
        <span className="font-semibold">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.monthlyTotal;
          })}
        </span>
        <span className="text-lg font-semibold">
          {i18n.t(
            ($) => {
              return $.billing.plans.pricePerMonth;
            },
            {
              price: formatUsd(monthlyTotalUsd, monthlyTotalFractionDigits),
            },
          )}
        </span>
      </div>
    </div>
  );
}

interface SubscriptionComparisonRow {
  readonly label: string;
  readonly current: ReactNode;
  readonly next: ReactNode;
  readonly changed: boolean;
}

function managedSubscriptionComparisonRows({
  currentPlan,
  currentTotals,
  plan,
  totals,
}: {
  readonly currentPlan: UsagePackPlan;
  readonly currentTotals: MemberUsageTotals;
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
}): readonly SubscriptionComparisonRow[] {
  const currentMonthlyTotalUsd =
    currentPlan.basePriceUsd + currentTotals.totalUsd;
  const nextMonthlyTotalUsd = plan.basePriceUsd + totals.totalUsd;
  return [
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
        return $.billing.plans.usagePacks.concurrentSlots;
      }),
      current: formatLocalizedNumber(planConcurrentSlots(currentPlan.tier)),
      next: formatLocalizedNumber(planConcurrentSlots(plan.tier)),
      changed:
        planConcurrentSlots(currentPlan.tier) !==
        planConcurrentSlots(plan.tier),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.purchasedCredits;
      }),
      current: formatLocalizedNumber(
        currentTotals.totalCredits - currentTotals.bonusCredits,
      ),
      next: formatLocalizedNumber(totals.totalCredits - totals.bonusCredits),
      changed:
        currentTotals.totalCredits - currentTotals.bonusCredits !==
        totals.totalCredits - totals.bonusCredits,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.bonusCredits;
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
  const rows = managedSubscriptionComparisonRows({
    currentPlan,
    currentTotals,
    plan,
    totals,
  });

  return <SubscriptionComparisonTable rows={rows} />;
}

function SubscriptionComparisonTable({
  rows,
}: {
  readonly rows: readonly SubscriptionComparisonRow[];
}) {
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
                  className={`px-3 py-2.5 text-left ${monthlyTotal ? "font-semibold text-foreground" : "font-normal text-muted-foreground"}`}
                >
                  {row.label}
                </th>
                <td
                  className={`px-3 py-2.5 text-right text-muted-foreground ${monthlyTotal ? "font-semibold" : ""}`}
                >
                  {row.current}
                </td>
                <td
                  className={`px-3 py-2.5 text-right ${monthlyTotal || row.changed ? "font-semibold" : "font-medium"} ${row.changed ? "text-primary" : "text-foreground"}`}
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

function SubscriptionChangeNotice({
  description,
  effectiveAt,
}: {
  readonly description: string;
  readonly effectiveAt: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300">
      <p>{description}</p>
      <p className="mt-1 font-medium">
        {i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.management.scheduledFor;
          },
          { date: formatBillingDate(effectiveAt) },
        )}
      </p>
    </div>
  );
}

interface UsagePackPaymentPreview {
  readonly immediateAmountCents: number;
  readonly immediateCreditGrant?: {
    readonly purchasedCredits: number;
    readonly bonusCredits: number;
    readonly totalCredits: number;
    readonly expiresAt?: string;
  };
}

export function UsagePackPaymentSummary({
  preview,
}: {
  readonly preview: UsagePackPaymentPreview;
}) {
  const immediateCreditGrant =
    preview.immediateCreditGrant &&
    preview.immediateCreditGrant.totalCredits > 0
      ? preview.immediateCreditGrant
      : null;
  const hasImmediateAmount = preview.immediateAmountCents > 0;

  if (!hasImmediateAmount && !immediateCreditGrant) {
    return null;
  }

  return (
    <div className="mt-1 divide-y divide-border/70 border-y border-border/70">
      {hasImmediateAmount && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
          <p className="text-sm font-semibold text-foreground">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management.immediateAmount;
            })}
          </p>
          <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
            {formatUsd(preview.immediateAmountCents / 100)}
          </p>
        </div>
      )}
      {immediateCreditGrant && (
        <div
          role="group"
          aria-label={i18n.t(($) => {
            return $.billing.plans.usagePacks.management.immediateCredits;
          })}
          className="py-4"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4">
            <p className="text-sm font-semibold text-foreground">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.immediateCredits;
              })}
            </p>
            <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
              +{formatLocalizedNumber(immediateCreditGrant.totalCredits)}
            </p>
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 text-xs">
            <span className="text-muted-foreground">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.purchasedCredits;
              })}
            </span>
            <span className="text-right font-medium tabular-nums text-foreground">
              +{formatLocalizedNumber(immediateCreditGrant.purchasedCredits)}
            </span>
            <span className="text-muted-foreground">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.bonusCredits;
              })}
            </span>
            <span className="text-right font-medium tabular-nums text-foreground">
              +{formatLocalizedNumber(immediateCreditGrant.bonusCredits)}
            </span>
          </div>
          {immediateCreditGrant.expiresAt && (
            <p className="mt-3 border-t border-border/70 pt-2 text-right text-[11px] text-muted-foreground">
              {i18n.t(
                ($) => {
                  return $.billing.usage.expires;
                },
                {
                  date: formatBillingDate(immediateCreditGrant.expiresAt),
                },
              )}
            </p>
          )}
        </div>
      )}
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
        {preview && <UsagePackPaymentSummary preview={preview} />}
        <SubscriptionOrderSummary plan={plan} totals={totals} />
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

function SubscriptionOrderSummary({
  monthlyTotalCents,
  plan,
  totals,
}: {
  readonly monthlyTotalCents?: number;
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
}) {
  return (
    <div className="pt-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.orderSummary;
        })}
      </p>
      <ManagedSubscriptionSummaryDetails
        monthlyTotalCents={monthlyTotalCents}
        plan={plan}
        totals={totals}
      />
    </div>
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

function managementMembersMatch(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[],
): boolean {
  const memberIds = new Set(
    members.map((member) => {
      return member.id;
    }),
  );
  const managedAllocations = managedAllocationsForMembers(management, members);
  return (
    memberIds.size === members.length &&
    memberIds.size === managedAllocations.length &&
    managedAllocations.every((allocation) => {
      return memberIds.has(allocation.memberId);
    }) &&
    management.allocations.every((allocation) => {
      return (
        memberIds.has(allocation.memberId) ||
        isPendingRemovedMemberAllocation(allocation)
      );
    })
  );
}

type ManagedUsagePackAllocation =
  UsagePackManagementResponse["allocations"][number];

function isPendingRemovedMemberAllocation(
  allocation: ManagedUsagePackAllocation,
): boolean {
  return (
    allocation.pendingChange?.kind === "removal" &&
    allocation.pendingChange.status !== "previewed"
  );
}

function managedAllocationsForMembers(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[],
): readonly ManagedUsagePackAllocation[] {
  const memberIds = new Set(
    members.map((member) => {
      return member.id;
    }),
  );
  return management.allocations.filter((allocation) => {
    return memberIds.has(allocation.memberId);
  });
}

function hasPendingUsagePackChange(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[] | undefined,
): boolean {
  const allocations = members
    ? managedAllocationsForMembers(management, members)
    : management.allocations;
  return allocations.some((allocation) => {
    return (
      allocation.pendingChange !== null &&
      allocation.pendingChange.status !== "previewed"
    );
  });
}

function hasRestorableUsagePackDowngrade(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[] | undefined,
): boolean {
  const allocations = members
    ? managedAllocationsForMembers(management, members)
    : management.allocations;
  const pendingChanges = allocations.flatMap((allocation) => {
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
  members: readonly MemberDisplay[] | undefined,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  if (!members) {
    return false;
  }
  const allocations = managedAllocationsForMembers(management, members);
  return (
    management.tier !== plan.tier ||
    !managementMembersMatch(management, members) ||
    allocations.some((allocation) => {
      return (
        memberUsageSelection(selections, allocation.memberId) !==
        managedUsagePackSelection(allocation)
      );
    })
  );
}

function restoresScheduledUsagePackDowngrade(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[] | undefined,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  const allocations = members
    ? managedAllocationsForMembers(management, members)
    : [];
  return (
    members !== undefined &&
    managementMembersMatch(management, members) &&
    management.tier === plan.tier &&
    hasRestorableUsagePackDowngrade(management, members) &&
    allocations.every((allocation) => {
      return (
        memberUsageSelection(selections, allocation.memberId) ===
        allocation.usagePackUsd
      );
    })
  );
}

function hasUsagePackDowngrade(
  management: UsagePackManagementResponse,
  members: readonly MemberDisplay[] | undefined,
  plan: UsagePackPlan,
  selections: Readonly<Record<string, MemberUsageSelection>>,
): boolean {
  const allocations = members
    ? managedAllocationsForMembers(management, members)
    : management.allocations;
  return (
    (management.tier === "team" && plan.tier === "pro") ||
    allocations.some((allocation) => {
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

function managedSubscriptionChangeState({
  management,
  members,
  plan,
  selections,
}: Pick<
  ManagedSubscriptionOrderSummaryProps,
  "management" | "members" | "plan" | "selections"
>) {
  return {
    hasConfigurationChange: hasUsagePackConfigurationChange(
      management,
      members,
      plan,
      selections,
    ),
    hasDowngrade: hasUsagePackDowngrade(management, members, plan, selections),
    hasPendingChange: hasPendingUsagePackChange(management, members),
    hasScheduledDowngrade: hasRestorableUsagePackDowngrade(management, members),
    restoresScheduledDowngrade: restoresScheduledUsagePackDowngrade(
      management,
      members,
      plan,
      selections,
    ),
  };
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
  const {
    hasConfigurationChange,
    hasDowngrade,
    hasPendingChange,
    hasScheduledDowngrade,
    restoresScheduledDowngrade,
  } = managedSubscriptionChangeState({ management, members, plan, selections });
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
        <SubscriptionChangeNotice
          description={i18n.t(($) => {
            return $.billing.plans.usagePacks.management.downgradeDescription;
          })}
          effectiveAt={management.currentPeriodEnd}
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
          (hasPendingChange && !hasScheduledDowngrade) ||
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
  const selections = useGet(memberUsageSelections$);
  const allMembers = useUsagePackMembers();
  const activeMembers = allMembers?.filter((member) => {
    return !member.isPending;
  });
  const paidPendingMembers = management
    ? allMembers?.filter((member) => {
        return member.isPending && member.usagePackUsd !== undefined;
      })
    : undefined;
  const members = management
    ? management.supportsMemberAdditions
      ? activeMembers
      : allMembers
        ? management.allocations.flatMap(
            (allocation): readonly MemberDisplay[] => {
              const member = allMembers.find((candidate) => {
                return candidate.id === allocation.memberId;
              });
              return member ? [member] : [];
            },
          )
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
        pendingMembers={paidPendingMembers}
      />
      {management ? (
        <ManagedSubscriptionOrderSummary
          currentTotals={managedMemberUsageTotals(management, members, catalog)}
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

function MigrationOrderSummary({
  effectiveAt,
  members,
  plan,
  selections,
  sourceTier,
  totals,
}: {
  readonly effectiveAt: string;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly sourceTier: UsagePackPlanTier;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const [previewLoadable, previewMigration] = useLoadableSet(
    previewUsagePackMigration$,
  );
  const previewing = previewLoadable.state === "loading";
  const previewError = previewLoadable.state === "hasError";
  const monthlyTotal = plan.basePriceUsd + totals.totalUsd;
  const currentMonthlyTotal = sourceTier === "pro" ? 20 : 200;
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
      <MigrationPlanComparison
        currentAmountCents={currentMonthlyTotal * 100}
        nextAmountCents={monthlyTotal * 100}
        nextTotals={totals}
        sourceTier={sourceTier}
        targetTier={plan.tier}
      />
      <SubscriptionChangeNotice
        description={i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.confirmDescription;
        })}
        effectiveAt={effectiveAt}
      />
      {previewError && (
        <p className="mt-3 text-xs text-destructive">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.error;
          })}
        </p>
      )}
      <Button
        type="button"
        className="mt-4 h-10 w-full text-sm font-medium"
        disabled={!members || previewing}
        onClick={() => {
          if (!members) {
            return;
          }
          detach(
            previewMigration(
              {
                targetTier: plan.tier,
                memberUsagePacks: checkoutMemberUsagePacks(members, selections),
              },
              pageSignal,
            ),
            Reason.DomCallback,
          );
        }}
      >
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.review;
        })}
      </Button>
    </section>
  );
}

function MigrationRevisionOrderSummary({
  catalog,
  configuration,
  effectiveAt,
  members,
  migrationId,
  plan,
  selections,
  totals,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly configuration: UsagePackMigrationConfiguration;
  readonly effectiveAt: string;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const [previewLoadable, previewRevision] = useLoadableSet(
    previewUsagePackMigrationRevision$,
  );
  const previewing = previewLoadable.state === "loading";
  const previewError = previewLoadable.state === "hasError";
  const currentPlan = usagePackPlan(configuration.tier);
  const currentTotals = migrationConfigurationTotals(configuration, catalog);
  const requested = members
    ? checkoutMemberUsagePacks(members, selections)
    : [];
  const hasConfigurationChange =
    members !== undefined &&
    migrationConfigurationChanged(configuration, plan.tier, requested);
  const rows = managedSubscriptionComparisonRows({
    currentPlan,
    currentTotals,
    plan,
    totals,
  });
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
      <SubscriptionComparisonTable rows={rows} />
      <SubscriptionChangeNotice
        description={i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.confirmDescription;
        })}
        effectiveAt={effectiveAt}
      />
      {previewError && (
        <p className="mt-3 text-xs text-destructive">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.error;
          })}
        </p>
      )}
      <Button
        type="button"
        className="mt-4 h-10 w-full text-sm font-medium"
        disabled={!hasConfigurationChange || previewing}
        onClick={() => {
          if (!members) {
            return;
          }
          detach(
            previewRevision(
              {
                migrationId,
                targetTier: plan.tier,
                memberUsagePacks: requested,
              },
              pageSignal,
            ),
            Reason.DomCallback,
          );
        }}
      >
        {hasConfigurationChange
          ? i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.review;
            })
          : i18n.t(($) => {
              return $.billing.plans.currentPlan;
            })}
      </Button>
    </section>
  );
}

function MigrationReviewDialog({
  totals,
}: {
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const preview = useGet(usagePackMigrationPreview$);
  const closePreview = useSet(closeUsagePackMigrationPreview$);
  const [confirmLoadable, confirmMigration] = useLoadableSet(
    confirmUsagePackMigration$,
  );
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";
  const handleConfirm = async (): Promise<void> => {
    if (!preview) {
      return;
    }
    await confirmMigration(preview.migrationId, pageSignal);
  };
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          closePreview();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.reviewTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.reviewDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <MigrationPreviewDetails preview={preview} totals={totals} />
        )}
        {error && (
          <p className="text-xs text-destructive">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.error;
            })}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={confirming}
            onClick={closePreview}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            disabled={confirming}
            onClick={() => {
              detach(handleConfirm(), Reason.DomCallback);
            }}
          >
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

function MigrationRevisionReviewDialog({
  members,
  migrationId,
  selections,
  totals,
}: {
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const preview = useGet(usagePackMigrationRevisionPreview$);
  const closePreview = useSet(closeUsagePackMigrationRevisionPreview$);
  const [confirmLoadable, confirmRevision] = useLoadableSet(
    confirmUsagePackMigrationRevision$,
  );
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";
  const handleConfirm = async (): Promise<void> => {
    if (!preview || !members) {
      return;
    }
    await confirmRevision(
      {
        migrationId,
        targetTier: preview.targetTier,
        memberUsagePacks: checkoutMemberUsagePacks(members, selections),
      },
      pageSignal,
    );
  };
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          closePreview();
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
        {preview && (
          <MigrationPreviewDetails preview={preview} totals={totals} />
        )}
        {error && (
          <p className="text-xs text-destructive">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.error;
            })}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={confirming}
            onClick={closePreview}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            disabled={confirming || !members}
            onClick={() => {
              detach(handleConfirm(), Reason.DomCallback);
            }}
          >
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

function MigrationPreviewDetails({
  preview,
  totals,
}: {
  readonly preview:
    | UsagePackMigrationPreviewResponse
    | UsagePackMigrationRevisionPreviewResponse;
  readonly totals: MemberUsageTotals;
}) {
  const previewTotals: MemberUsageTotals = {
    bonusCredits: preview.bonusCredits,
    totalCredits: preview.totalCredits,
    totalUsd: totals.totalUsd,
  };
  return (
    <>
      <SubscriptionOrderSummary
        monthlyTotalCents={preview.nextRecurringAmountCents}
        plan={usagePackPlan(preview.targetTier)}
        totals={previewTotals}
      />
      <SubscriptionChangeNotice
        description={i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.confirmDescription;
        })}
        effectiveAt={preview.effectiveAt}
      />
    </>
  );
}

function MigrationPlanComparison({
  currentAmountCents,
  nextAmountCents,
  nextTotals,
  sourceTier,
  targetTier,
}: {
  readonly currentAmountCents: number;
  readonly nextAmountCents: number;
  readonly nextTotals: MemberUsageTotals;
  readonly sourceTier: UsagePackPlanTier;
  readonly targetTier: UsagePackPlanTier;
}) {
  const rows: readonly SubscriptionComparisonRow[] = [
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.planStep;
      }),
      current: (
        <span className="inline-flex items-center justify-end gap-1.5">
          <span>{planName(sourceTier)}</span>
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground zero-badge">
            {i18n.t(($) => {
              return $.billing.plans.legacy;
            })}
          </span>
        </span>
      ),
      next: planName(targetTier),
      changed: true,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.memberPackages;
      }),
      current: formatUsd(0, 0),
      next: formatUsd(nextTotals.totalUsd, 0),
      changed: nextTotals.totalUsd !== 0,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.concurrentSlots;
      }),
      current: formatLocalizedNumber(planConcurrentSlots(sourceTier)),
      next: formatLocalizedNumber(planConcurrentSlots(targetTier)),
      changed:
        planConcurrentSlots(sourceTier) !== planConcurrentSlots(targetTier),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.purchasedCredits;
      }),
      current: formatLocalizedNumber(legacyPlanMonthlyCredits(sourceTier)),
      next: formatLocalizedNumber(
        nextTotals.totalCredits - nextTotals.bonusCredits,
      ),
      changed:
        legacyPlanMonthlyCredits(sourceTier) !==
        nextTotals.totalCredits - nextTotals.bonusCredits,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.bonusCredits;
      }),
      current: formatLocalizedNumber(0),
      next: formatLocalizedNumber(nextTotals.bonusCredits),
      changed: nextTotals.bonusCredits !== 0,
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.monthlyTotal;
      }),
      current: i18n.t(
        ($) => {
          return $.billing.plans.pricePerMonth;
        },
        { price: formatUsd(currentAmountCents / 100, 0) },
      ),
      next: i18n.t(
        ($) => {
          return $.billing.plans.pricePerMonth;
        },
        { price: formatUsd(nextAmountCents / 100, 0) },
      ),
      changed: currentAmountCents !== nextAmountCents,
    },
  ];

  return <SubscriptionComparisonTable rows={rows} />;
}

export function UsagePackMigrationPlanSelectionPage({
  configuration,
  onBack,
  onSelect,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly onBack: () => void;
  readonly onSelect: (tier: UsagePackPlanTier) => void;
}) {
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  const setMemberUsageSelections = useSet(setMemberUsageSelections$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  return (
    <div
      className="flex flex-col gap-5 outline-none"
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      <UsagePackPageHeader
        description={i18n.t(($) => {
          return $.billing.plans.changeAnytime;
        })}
        onBack={onBack}
        title={i18n.t(($) => {
          return $.billing.plans.compare;
        })}
      />
      {!catalog ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : (
        <>
          <PricingSteps current={1} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {USAGE_PACK_PLANS.map((plan) => {
              const action = configuration
                ? usagePackPlanAction(
                    false,
                    configuration.tier,
                    configuration.tier,
                    plan.tier,
                  )
                : "convert";
              return (
                <PlanSelectionCard
                  key={plan.tier}
                  action={action}
                  busy={false}
                  keepsMemberPackages={configuration !== null}
                  minimumPackagePriceUsd={
                    usagePackCatalogItem(catalog, MINIMUM_USAGE_PACK_USD)
                      .priceUsd
                  }
                  plan={plan}
                  onAction={() => {
                    setMemberUsageSelections(
                      configuration
                        ? migrationConfigurationSelections(configuration)
                        : {},
                    );
                    onSelect(plan.tier);
                  }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function UsagePackMigrationPage({
  configuration,
  effectiveAt,
  migrationId,
  onBack,
  sourceTier,
  targetTier,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly effectiveAt: string;
  readonly migrationId: string | null;
  readonly onBack: () => void;
  readonly sourceTier: UsagePackPlanTier;
  readonly targetTier: UsagePackPlanTier;
}) {
  const selections = useGet(memberUsageSelections$);
  const members = useUsagePackMembers();
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const plan = USAGE_PACK_PLANS.find((candidate) => {
    return candidate.tier === targetTier;
  });
  if (!plan) {
    throw new Error(`Usage pack migration plan is missing for ${targetTier}`);
  }
  const totals = catalog
    ? memberUsageTotals(members ?? [], selections, catalog)
    : { bonusCredits: 0, totalCredits: 0, totalUsd: 0 };
  return (
    <div
      className="flex flex-col gap-5 outline-none"
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      {!catalog ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : (
        <>
          <PricingPageHeader onBack={onBack} step={2} />
          <SelectedPlanSummary plan={plan} />
          <MemberUsageConfiguration
            catalog={catalog}
            management={null}
            members={members}
          />
          {configuration && migrationId ? (
            <>
              <MigrationRevisionOrderSummary
                catalog={catalog}
                configuration={configuration}
                effectiveAt={effectiveAt}
                members={members}
                migrationId={migrationId}
                plan={plan}
                selections={selections}
                totals={totals}
              />
              <MigrationRevisionReviewDialog
                members={members}
                migrationId={migrationId}
                selections={selections}
                totals={totals}
              />
            </>
          ) : (
            <>
              <MigrationOrderSummary
                effectiveAt={effectiveAt}
                members={members}
                plan={plan}
                selections={selections}
                sourceTier={sourceTier}
                totals={totals}
              />
              <MigrationReviewDialog totals={totals} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function UsagePackPricingPage({
  checkoutAllowed,
  currentTier,
  onBack,
}: {
  readonly checkoutAllowed: boolean;
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
      (management !== null ||
        canCheckoutUsagePackPlan(checkoutAllowed, currentTier, plan.tier))
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
          checkoutAllowed={checkoutAllowed}
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
