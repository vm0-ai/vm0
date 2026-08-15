import { ArrowLeft, CalendarDays, ChevronRight, Info, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import type {
  MemberUsagePack,
  UsagePackCatalogItem,
  UsagePackManagementResponse,
  UsagePackMigrationConfiguration,
  UsagePackMigrationStateResponse,
  UsagePackSubscriptionChangePreviewResponse,
  UsagePackMigrationPreviewResponse,
  UsagePackMigrationRevisionPreviewResponse,
} from "@okouai/api-contracts/contracts/zero-billing";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { currentUserInfo$ } from "../../../../signals/auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { UserAvatar } from "../../../components/avatar.tsx";
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
  resetUsagePackPricing$,
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

// Both plans carry the same shared-agent allowance; Team only adds concurrency,
// voice input and support on top of it.
const SHARED_AGENT_COUNT = 7;

function planVoiceInput(tier: UsagePackPlanTier): {
  readonly minutes: number;
  readonly requests: number;
} {
  return tier === "pro"
    ? { minutes: 200, requests: 300 }
    : { minutes: 500, requests: 500 };
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
      <UserAvatar
        imageUrl={member.imageUrl}
        initial={member.name.charAt(0).toUpperCase()}
        name={member.name}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {member.name}
          </span>
          {member.isCurrent && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground zero-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.you;
              })}
            </span>
          )}
          {member.isPending && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground zero-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.pending;
              })}
            </span>
          )}
        </span>
        {member.email && member.email !== member.name && (
          <span className="mt-0.5 block truncate text-sm text-muted-foreground">
            {member.email}
          </span>
        )}
      </span>
    </div>
  );
}

/* Every ledger row lands on the same three columns: who or what the line is,
   the control, and the money. The money column is wide enough for the total
   row's 24px figure at five digits -- it is the one number that has to fit,
   and a shared width is what keeps every amount on one right edge. */
const LEDGER_ROW =
  "grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(15rem,17rem)_9.5rem] items-center gap-3 py-2.5";
const LEDGER_RULE = "border-t-[0.7px] border-[hsl(var(--gray-100))]";

function LedgerPrice({
  fractionDigits = 0,
  strong = false,
  value,
}: {
  readonly fractionDigits?: number;
  readonly strong?: boolean;
  readonly value: number;
}) {
  return (
    <span
      className={
        strong
          ? "text-right text-2xl font-medium tracking-tight tabular-nums text-foreground"
          : "text-right text-sm font-medium tabular-nums text-foreground"
      }
    >
      {formatUsd(value, fractionDigits)}
      <span className="text-sm font-normal tracking-normal text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.perMonth;
        })}
      </span>
    </span>
  );
}

function usagePackCreditsLabel(item: UsagePackCatalogItem): string {
  const discount = Math.round((item.bonusCredits / item.totalCredits) * 100);
  const credits = formatLocalizedNumber(item.totalCredits);
  return discount > 0
    ? i18n.t(
        ($) => {
          return $.billing.plans.usagePacks.packCreditsDiscount;
        },
        { credits, discount },
      )
    : i18n.t(
        ($) => {
          return $.billing.plans.usagePacks.packCredits;
        },
        { credits },
      );
}

function LedgerPlanRow({ plan }: { readonly plan: UsagePackPlan }) {
  return (
    <div className={LEDGER_ROW}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">
          <img
            src={plan.image}
            alt=""
            loading="lazy"
            className="h-10 w-10 max-w-none object-contain"
          />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.namedPlan;
            },
            { plan: planName(plan.tier) },
          )}
        </span>
      </div>
      <div />
      <LedgerPrice value={plan.basePriceUsd} />
    </div>
  );
}

function LedgerTotalRow({
  bonusCredits,
  credits,
  totalUsd,
}: {
  readonly bonusCredits: number;
  readonly credits: number;
  readonly totalUsd: number;
}) {
  return (
    <div className={`${LEDGER_ROW} border-t-[0.7px] border-border py-4`}>
      <span className="text-sm font-medium text-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.monthlyTotal;
        })}
      </span>
      <span className="truncate px-3 text-sm text-muted-foreground">
        {bonusCredits > 0
          ? i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.totalCreditsWithBonus;
              },
              {
                bonus: formatLocalizedNumber(bonusCredits),
                credits: formatLocalizedNumber(credits),
              },
            )
          : i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.packCredits;
              },
              { credits: formatLocalizedNumber(credits) },
            )}
      </span>
      <LedgerPrice strong value={totalUsd} />
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
    <div className={LEDGER_ROW}>
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
            className="h-9 w-full text-sm"
            aria-label={i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.selectUsage;
              },
              { name: member.name },
            )}
          >
            {/* The price lives in its own column, so the trigger only carries
                what the package buys. */}
            <span className="min-w-0 flex-1 truncate text-left">
              {usagePackCreditsLabel(usagePackCatalogItem(catalog, selection))}
            </span>
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
          <p className="mt-1 truncate text-sm font-medium text-amber-600 dark:text-amber-300">
            {downgradeSummary}
          </p>
        )}
      </div>
      <LedgerPrice value={usagePackCatalogItem(catalog, selection).priceUsd} />
    </div>
  );
}

function MemberUsageFooter() {
  return (
    <div className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-50 text-xs font-medium"
      >
        <Info className="size-3.5" />
      </span>
      <p>
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
  plan,
  totals,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly management: UsagePackManagementResponse | null;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly onSelectionChange?: () => void;
  readonly pendingMembers?: readonly MemberDisplay[];
  readonly plan: UsagePackPlan;
  readonly totals: MemberUsageTotals;
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
      className="flex flex-col"
    >
      <LedgerPlanRow plan={plan} />

      {displayedMembers.map((member) => {
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
          <div key={member.id} className={LEDGER_RULE}>
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

      <LedgerTotalRow
        bonusCredits={totals.bonusCredits}
        credits={totals.totalCredits}
        totalUsd={plan.basePriceUsd + totals.totalUsd}
      />
    </section>
  );
}

/* One price, expressed as a floor. A workspace pays the plan plus one package
   for every member, and packages run from $20 to $200 -- so a single figure
   would only ever be right for a one-member workspace on the cheapest package.
   The line under the figure prints what makes it up. */
function PlanPrice({
  basePriceUsd,
  catalog,
}: {
  readonly basePriceUsd: number;
  readonly catalog: readonly UsagePackCatalogItem[];
}) {
  const packagePrices = catalog.map((item) => {
    return item.priceUsd;
  });
  const lowestPackageUsd = Math.min(...packagePrices);
  const highestPackageUsd = Math.max(...packagePrices);
  return (
    <div className="-mx-6 mt-4 border-y-[0.7px] border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-0))] px-6 py-4">
      <p className="text-2xl font-medium leading-tight tabular-nums text-foreground">
        <span className="text-sm font-normal text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.priceFrom;
          })}{" "}
        </span>
        {formatUsd(basePriceUsd + lowestPackageUsd, 0)}
        <span className="text-sm font-normal text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.perMonth;
          })}
        </span>
      </p>
      <p className="mt-2 text-sm leading-snug text-muted-foreground">
        {i18n.t(
          ($) => {
            return $.billing.plans.usagePacks.planPlusPackages;
          },
          {
            highest: formatUsd(highestPackageUsd, 0),
            lowest: formatUsd(lowestPackageUsd, 0),
            plan: formatUsd(basePriceUsd, 0),
          },
        )}
      </p>
    </div>
  );
}

/* Both plans list the same rows in the same order, so the two columns can be
   read across rather than compared item by item between two unequal lists. */
function planComparisonRows(
  tier: UsagePackPlanTier,
): readonly { readonly label: string; readonly value: string }[] {
  const voice = planVoiceInput(tier);
  return [
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.concurrentRuns;
      }),
      value: formatLocalizedNumber(planConcurrentSlots(tier)),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.addOnConcurrency;
      }),
      value:
        tier === "team"
          ? i18n.t(($) => {
              return $.billing.plans.comparison.available;
            })
          : "—",
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.sharedAgents;
      }),
      value: formatLocalizedNumber(SHARED_AGENT_COUNT),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.privateAgents;
      }),
      value: i18n.t(($) => {
        return $.billing.plans.comparison.unlimited;
      }),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.voiceInput;
      }),
      value: i18n.t(
        ($) => {
          return $.billing.plans.comparison.voiceInputValue;
        },
        {
          minutes: formatLocalizedNumber(voice.minutes),
          requests: formatLocalizedNumber(voice.requests),
        },
      ),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.ownLlmKeys;
      }),
      value: i18n.t(($) => {
        return $.billing.plans.comparison.included;
      }),
    },
    {
      label: i18n.t(($) => {
        return $.billing.plans.comparison.support;
      }),
      value:
        tier === "team"
          ? i18n.t(($) => {
              return $.billing.plans.comparison.supportPriority;
            })
          : i18n.t(($) => {
              return $.billing.plans.comparison.supportEmail;
            }),
    },
  ];
}

function PlanComparison({ tier }: { readonly tier: UsagePackPlanTier }) {
  return (
    <div className="mt-5 text-muted-foreground">
      {planComparisonRows(tier).map((row, index) => {
        return (
          <div
            key={row.label}
            className={`flex items-baseline justify-between gap-4 py-1.5 text-sm font-medium leading-snug ${
              index > 0 ? "border-t-[0.7px] border-[hsl(var(--gray-100))]" : ""
            }`}
          >
            <span>{row.label}</span>
            <span className="text-right font-normal tabular-nums">
              {row.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PlanSelectionPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-xl bg-card zero-border sm:grid-cols-2">
      {children}
    </div>
  );
}

function PlanSelectionCard({
  action,
  busy,
  catalog,
  divided,
  onAction,
  plan,
}: {
  readonly action: PlanSelectionAction;
  readonly busy: boolean;
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly divided: boolean;
  readonly onAction: () => void;
  readonly plan: UsagePackPlan;
}) {
  const name = planName(plan.tier);
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
      className={`flex flex-col p-6 ${
        divided
          ? "border-t-[0.7px] border-[hsl(var(--gray-200))] sm:border-l-[0.7px] sm:border-t-0"
          : ""
      }`}
    >
      <div className="flex items-center gap-2.5">
        <img
          src={plan.image}
          alt=""
          loading="lazy"
          className="h-9 w-9 shrink-0 object-contain"
        />
        <h3 className="text-2xl font-medium leading-tight text-foreground">
          {name}
        </h3>
      </div>
      <p className="mt-2 min-h-[42px] text-sm leading-normal text-muted-foreground">
        {planDescription(plan.tier)}
      </p>

      <PlanPrice basePriceUsd={plan.basePriceUsd} catalog={catalog} />

      <PlanComparison tier={plan.tier} />

      {/* The action closes the column, under everything it buys. */}
      <div className="mt-auto pt-6">
        <Button
          type="button"
          variant={plan.popular ? "default" : "outline"}
          className="h-10 w-full text-sm font-medium"
          disabled={action === "disabled" || busy}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </article>
  );
}

function PricingBackButton({
  inDialogHeader = false,
  onBack,
}: {
  // The dialog header pairs back with close, so it draws both at the same
  // 36px box and 20px glyph. The page header carries back on its own.
  readonly inDialogHeader?: boolean;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={onBack}
            variant="quiet"
            size={inDialogHeader ? "icon" : "icon-xs"}
            iconSize={inDialogHeader ? "lg" : "sm"}
            aria-label={t(($) => {
              return $.billing.common.back;
            })}
          >
            <ArrowLeft size={inDialogHeader ? 20 : 16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-sm">
            {t(($) => {
              return $.billing.common.back;
            })}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function UsagePackPageHeader({
  description,
  onBack,
  title,
  trailing,
}: {
  readonly description?: string;
  readonly onBack: () => void;
  readonly title: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <PricingBackButton onBack={onBack} />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {trailing}
    </div>
  );
}

/* A checkout hands off to Stripe after the packages are configured, so it ends
   at step 2. Changing an existing subscription has one more step: the charges
   this change makes today have to be reviewed before they are confirmed. */
type PricingStep = 1 | 2 | 3;
type PricingStepTotal = 2 | 3;

function PricingStepIndicator({
  current,
  total,
}: {
  readonly current: PricingStep;
  readonly total: PricingStepTotal;
}) {
  return (
    <span className="shrink-0 text-sm text-muted-foreground">
      {i18n.t(
        ($) => {
          return $.billing.plans.usagePacks.stepOfTotal;
        },
        { current, total },
      )}
    </span>
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
      trailing={<PricingStepIndicator current={step} total={2} />}
    />
  );
}

function pricingStepTitle(step: PricingStep): string {
  if (step === 1) {
    return i18n.t(($) => {
      return $.billing.plans.usagePacks.choosePlan;
    });
  }
  if (step === 2) {
    return i18n.t(($) => {
      return $.billing.plans.usagePacks.configurePackages;
    });
  }
  return i18n.t(($) => {
    return $.billing.plans.usagePacks.management.reviewTitle;
  });
}

/* The pricing steps are their own modal rather than a page inside Settings:
   picking a plan is a decision the workspace makes in one sitting, and a
   dialog keeps the billing overview it is decided against in place behind it.
   Every step shares one dialog frame at one fixed width and height, so moving
   between them only changes the body -- the header band, the step counter and
   the outer edges hold still. That is also why the review is a step and not a
   dialog of its own: stacking a third modal on the flow would bury both the
   billing tab and the packages the review is about. The height is the tallest
   step's (plan selection), and the body insets its content so no rule, tint or
   column runs into the frame.

   The dialog is mounted only while the flow is open, so the plan catalog and
   the subscription it loads stay owned by the flow rather than by every visit
   to the billing tab. */
function PricingStepDialog({
  children,
  flush = false,
  onBack,
  onClose,
  step,
  total,
}: {
  readonly children: ReactNode;
  readonly flush?: boolean;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly step: PricingStep;
  readonly total: PricingStepTotal;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(46rem,calc(100dvh-4rem))] w-[calc(100vw-2rem)] max-w-[860px] flex-col gap-0 overflow-hidden p-0"
      >
        {/* The close button is an item in this row rather than a box pinned to
            the frame, so the title, the step counter and the close glyph share
            one centre line and one right inset. */}
        <DialogHeader className="h-14 flex-row shrink-0 items-center gap-3 space-y-0 border-b-[0.7px] border-[hsl(var(--gray-200))] py-0 pl-6 pr-4 text-left">
          {onBack && <PricingBackButton inDialogHeader onBack={onBack} />}
          <DialogTitle className="min-w-0 flex-1 text-base font-medium leading-none">
            {pricingStepTitle(step)}
          </DialogTitle>
          <PricingStepIndicator current={step} total={total} />
          <DialogClose
            className="icon-button -ml-1 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={t(($) => {
              return $.settings.shared.close;
            })}
          >
            <X size={20} />
          </DialogClose>
        </DialogHeader>
        {/* No bottom inset on the scrolling body: a step that ends in an action
            bar lets the bar sit on the frame's edge. Otherwise the bar would
            float a padding's width above the frame whenever the body is short
            enough not to scroll. */}
        <div
          className={
            flush
              ? "flex min-h-0 flex-1 flex-col"
              : "dialog-scrollable flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-5"
          }
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrderSummary({
  checkoutDisabled,
  checkoutError,
  checkoutLoading,
  onCheckout,
  plan,
}: {
  readonly checkoutDisabled: boolean;
  readonly checkoutError: string | null;
  readonly checkoutLoading: boolean;
  readonly onCheckout: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly plan: UsagePackPlan;
}) {
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.orderSummary;
      })}
      className={STEP_ACTION_BAR}
    >
      {checkoutError && (
        <p className="text-sm text-destructive">{checkoutError}</p>
      )}
      <Button
        className="h-10 w-full text-sm font-medium"
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
}: {
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
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
  onAction,
  resolveAction,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly onAction: (
    plan: UsagePackPlanTier,
    action: PlanSelectionAction,
  ) => void;
  readonly resolveAction: (
    targetTier: UsagePackPlanTier,
  ) => PlanSelectionAction;
}) {
  return (
    /* No panel border inside the dialog frame -- the only rule between the two
       plans is the hairline the second column carries, and it runs the full
       height of the body so the frame reads as two columns, not two cards.
       The columns take the scroll; the note stays pinned to the frame. */
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="dialog-scrollable grid min-h-0 flex-1 grid-cols-1 overflow-y-auto sm:grid-cols-2">
        {USAGE_PACK_PLANS.map((plan, index) => {
          const action = resolveAction(plan.tier);
          return (
            <PlanSelectionCard
              key={plan.tier}
              action={action}
              busy={false}
              catalog={catalog}
              divided={index > 0}
              plan={plan}
              onAction={() => {
                onAction(plan.tier, action);
              }}
            />
          );
        })}
      </div>
      <p className="shrink-0 border-t-[0.7px] border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-0))] px-6 py-5 text-sm leading-snug text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.packagePerMemberNote;
        })}
      </p>
    </div>
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

/* A review dialog is too narrow for the page ledger's control column, so its
   rows keep only the two rails that matter on a confirmation screen: what the
   line is, and the money. Every amount ends on the same right edge.

   Exactly three type levels, so a reader can tell a heading from a row without
   reading it: block name at 12px medium muted, row label at 14px medium ink,
   qualifier at 11px muted on its own line. A qualifier never shares the label's
   line -- one middot cannot mean "expires", "includes" and "consists of" at
   once. Rule weight carries the structure: gray-200 opens a block, gray-100
   separates rows inside it. */
const REVIEW_ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3";
const REVIEW_HAIRLINE = "border-t-[0.7px] border-[hsl(var(--gray-100))]";
const REVIEW_RULE = "border-t-[0.7px] border-border";

/* A step's action stays on the frame's foot instead of scrolling away with the
   body it belongs to: a long member list must never put the decision out of
   reach. The bar spans the full frame width, so it cancels the body's inset and
   restores it inside, and it carries the frame's own surface so the rows pass
   underneath it rather than through it. */
const STEP_ACTION_BAR = `sticky bottom-0 -mx-5 mt-auto flex flex-col gap-3 bg-card px-5 py-4 ${REVIEW_RULE}`;

function ReviewSectionLabel({ label }: { readonly label: string }) {
  return (
    <p className="pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
      {label}
    </p>
  );
}

function ReviewRowLabel({
  label,
  meta,
}: {
  readonly label: string;
  readonly meta?: string;
}) {
  return (
    <span className="min-w-0">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {meta !== undefined && (
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {meta}
        </span>
      )}
    </span>
  );
}

function ReviewRow({
  amount,
  label,
  meta,
  rule = "hairline",
  strong = false,
}: {
  readonly amount: string;
  readonly label: string;
  readonly meta?: string;
  readonly rule?: "hairline" | "strong";
  readonly strong?: boolean;
}) {
  return (
    <div
      className={`${REVIEW_ROW} ${strong ? "py-3.5" : "py-2.5"} ${
        rule === "strong" ? REVIEW_RULE : REVIEW_HAIRLINE
      }`}
    >
      <ReviewRowLabel label={label} {...(meta === undefined ? {} : { meta })} />
      <span
        className={
          strong
            ? "text-right text-3xl font-light tracking-tight tabular-nums text-foreground"
            : "text-right text-sm font-medium tabular-nums text-foreground"
        }
      >
        {amount}
      </span>
    </div>
  );
}

/* The one line the workspace is agreeing to pay every month. It carries the
   same weight as the page ledger's total so the two screens read as one. */
function ReviewTotalRow({
  fractionDigits,
  value,
}: {
  readonly fractionDigits: number;
  readonly value: number;
}) {
  return (
    <div className={`${REVIEW_ROW} py-4 ${REVIEW_RULE}`}>
      <ReviewRowLabel
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.monthlyTotal;
        })}
      />
      <LedgerPrice strong fractionDigits={fractionDigits} value={value} />
    </div>
  );
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
  const concurrentSlots = planConcurrentSlots(plan.tier);
  return (
    <div>
      <ReviewSectionLabel
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.management.everyMonth;
        })}
      />
      <ReviewRow
        rule="strong"
        label={i18n.t(
          ($) => {
            return $.billing.plans.namedPlan;
          },
          { plan: planName(plan.tier) },
        )}
        meta={i18n.t(
          ($) => {
            return $.billing.concurrency.concurrentRun;
          },
          {
            count: concurrentSlots,
            value: formatLocalizedNumber(concurrentSlots),
          },
        )}
        amount={formatUsd(plan.basePriceUsd, 0)}
      />
      <ReviewRow
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.memberPackages;
        })}
        amount={formatUsd(totals.totalUsd, 0)}
      />
      <ReviewRow
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.credits;
        })}
        {...(totals.bonusCredits > 0
          ? {
              meta: i18n.t(
                ($) => {
                  return $.billing.plans.usagePacks.bonusIncluded;
                },
                { credits: formatLocalizedNumber(totals.bonusCredits) },
              ),
            }
          : {})}
        amount={formatLocalizedNumber(totals.totalCredits)}
      />
      <ReviewTotalRow
        fractionDigits={Number.isInteger(monthlyTotalUsd) ? 0 : 2}
        value={monthlyTotalUsd}
      />
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
  const monthlyTotal = rows.at(-1);

  /* The ledger above this already states what the workspace will pay, so the
     row-by-row comparison opens on demand. The disclosure and copy follow the
     same icon and text rails as the note above, while the values keep their
     shared right edges. The migration screens keep their comparison contained
     -- there it is the whole point of the page. */
  return (
    <details className="group">
      <summary className="grid cursor-pointer list-none grid-cols-[40%_30%_30%] items-center py-3">
        <span className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2">
          <span className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
            <ChevronRight
              size={14}
              className="transition-transform group-open:rotate-90"
            />
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-foreground">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management.comparison;
            })}
          </span>
        </span>
        {monthlyTotal && (
          <>
            <span className="col-start-2 row-start-1 text-right text-[13px] leading-5 tabular-nums text-muted-foreground group-open:hidden">
              {monthlyTotal.current}
            </span>
            <span className="col-start-3 row-start-1 text-right text-[13px] leading-5 tabular-nums text-muted-foreground group-open:hidden">
              {monthlyTotal.next}
            </span>
            <span className="col-start-2 row-start-1 hidden text-right text-[13px] leading-5 text-muted-foreground group-open:block">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.current;
              })}
            </span>
            <span className="col-start-3 row-start-1 hidden text-right text-[13px] leading-5 text-muted-foreground group-open:block">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.new;
              })}
            </span>
          </>
        )}
      </summary>
      <SubscriptionComparisonTable presentation="flat" rows={rows} />
    </details>
  );
}

function SubscriptionComparisonTable({
  presentation = "contained",
  rows,
}: {
  readonly presentation?: "contained" | "flat";
  readonly rows: readonly SubscriptionComparisonRow[];
}) {
  const flat = presentation === "flat";
  return (
    <div
      className={
        flat
          ? "pb-2"
          : "mt-4 overflow-hidden rounded-lg border border-border/70"
      }
    >
      <table
        aria-label={i18n.t(($) => {
          return $.billing.plans.usagePacks.management.comparison;
        })}
        className={
          flat ? "w-full table-fixed text-[13px]" : "w-full table-fixed text-sm"
        }
      >
        {flat && (
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-[30%]" />
            <col className="w-[30%]" />
          </colgroup>
        )}
        <thead
          className={
            flat
              ? "sr-only"
              : "bg-muted/40 text-sm font-medium uppercase tracking-wide text-muted-foreground"
          }
        >
          <tr>
            {flat && <th scope="col" />}
            <th
              scope="col"
              className={flat ? "text-left" : "w-[40%] px-3 py-2 text-left"}
            />
            <th
              scope="col"
              className={flat ? "text-right" : "w-[30%] px-3 py-2 text-right"}
            >
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.current;
              })}
            </th>
            <th
              scope="col"
              className={flat ? "text-right" : "w-[30%] px-3 py-2 text-right"}
            >
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
                className={
                  flat
                    ? ""
                    : `border-t border-border/60 ${monthlyTotal ? "bg-muted/20" : ""}`
                }
              >
                {flat && <td aria-hidden="true" />}
                <th
                  scope="row"
                  className={
                    flat
                      ? `${monthlyTotal ? "pb-1.5 pt-3 font-medium text-foreground" : "py-1.5 font-normal text-muted-foreground"} text-left`
                      : `px-3 py-2.5 text-left ${monthlyTotal ? "font-medium text-foreground" : "font-normal text-muted-foreground"}`
                  }
                >
                  {row.label}
                </th>
                <td
                  className={
                    flat
                      ? `${monthlyTotal ? "pb-1.5 pt-3 font-medium" : "py-1.5"} text-right tabular-nums text-muted-foreground`
                      : `px-3 py-2.5 text-right text-muted-foreground ${monthlyTotal ? "font-medium" : ""}`
                  }
                >
                  {row.current}
                </td>
                {/* Contained comparisons use weight to mark a changed value.
                    The flat management disclosure keeps both columns quiet. */}
                <td
                  className={
                    flat
                      ? `${monthlyTotal ? "pb-1.5 pt-3 font-medium" : "py-1.5"} text-right tabular-nums text-muted-foreground`
                      : `px-3 py-2.5 text-right text-foreground ${monthlyTotal || row.changed ? "font-semibold" : "font-medium"}`
                  }
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
    <div className="mt-3 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-sm leading-relaxed text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300">
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

function ScheduledUsagePackDowngradeNotice({
  effectiveAt,
}: {
  readonly effectiveAt: string;
}) {
  const title = i18n.t(($) => {
    return $.billing.plans.usagePacks.management.scheduledDowngradeTitle;
  });
  return (
    <div
      role="status"
      aria-label={title}
      className="flex items-center gap-3 rounded-xl bg-gray-50 p-3"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground">
        <CalendarDays aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.plans.usagePacks.management
                .scheduledDowngradeDescription;
            },
            { date: formatBillingDate(effectiveAt) },
          )}
        </p>
      </div>
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

/* What confirming does right now: the charge, and the credits it buys. The
   recurring subscription is a separate, separately named block below, so the
   two large numerals answer two questions instead of competing. */
function UsagePackChangeCharges({
  preview,
}: {
  readonly preview: UsagePackPaymentPreview;
}) {
  const grant =
    preview.immediateCreditGrant &&
    preview.immediateCreditGrant.totalCredits > 0
      ? preview.immediateCreditGrant
      : null;
  const hasImmediateAmount = preview.immediateAmountCents > 0;
  if (!hasImmediateAmount && !grant) {
    return null;
  }
  return (
    <div>
      <ReviewSectionLabel
        label={i18n.t(($) => {
          return $.billing.plans.usagePacks.management.today;
        })}
      />
      {hasImmediateAmount && (
        <ReviewRow
          strong
          rule="strong"
          label={i18n.t(($) => {
            return $.billing.plans.usagePacks.management.immediateAmount;
          })}
          meta={i18n.t(($) => {
            return $.billing.plans.usagePacks.management.immediateAmountNote;
          })}
          amount={formatUsd(preview.immediateAmountCents / 100)}
        />
      )}
      {grant && (
        <ReviewRow
          rule={hasImmediateAmount ? "hairline" : "strong"}
          label={i18n.t(($) => {
            return $.billing.plans.usagePacks.management.immediateCredits;
          })}
          {...(grant.expiresAt === undefined
            ? {}
            : {
                meta: i18n.t(
                  ($) => {
                    return $.billing.usage.expires;
                  },
                  { date: formatBillingDate(grant.expiresAt) },
                ),
              })}
          amount={`+${formatLocalizedNumber(grant.totalCredits)}`}
        />
      )}
    </div>
  );
}

/* The last step of a subscription change. It repeats the monthly ledger the
   configuration step already showed and adds what the change costs today, so
   it reads as that step's conclusion rather than a separate decision. The
   frame's back arrow discards the preview, which is what this screen's Cancel
   button used to do, and the confirm keeps the configuration step's place and
   shape at the foot of the dialog. */
function PackageReviewStep({
  plan,
  preview,
  totals,
}: {
  readonly plan: UsagePackPlan;
  readonly preview: UsagePackSubscriptionChangePreviewResponse;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const [confirmationLoadable, confirmChange] = useLoadableSet(
    confirmUsagePackSubscriptionChange$,
  );
  const confirming = confirmationLoadable.state === "loading";
  const error =
    confirmationLoadable.state === "hasError"
      ? i18n.t(($) => {
          return $.billing.plans.usagePacks.planChangeError;
        })
      : null;
  const submitChange = async (): Promise<void> => {
    await confirmChange(pageSignal);
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-[13px] text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.management.reviewDescription;
        })}
      </p>
      <UsagePackChangeCharges preview={preview} />
      <ManagedSubscriptionSummaryDetails plan={plan} totals={totals} />
      <div className={STEP_ACTION_BAR}>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="button"
          className="h-10 w-full text-sm font-medium"
          disabled={confirming}
          onClick={() => {
            detach(submitChange(), Reason.DomCallback);
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
      </div>
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
  return i18n.t(($) => {
    return $.billing.common.confirm;
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
  const [previewLoadable, previewChange] = useLoadableSet(
    previewUsagePackSubscriptionChange$,
  );
  const previewing = previewLoadable.state === "loading";
  const error =
    previewLoadable.state === "hasError"
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
  const hasSubscriptionAction =
    (hasConfigurationChange || restoresScheduledDowngrade) &&
    (!hasPendingChange || hasScheduledDowngrade);
  const scheduledDowngradeEffectiveAt =
    hasScheduledDowngrade && !hasConfigurationChange
      ? management.currentPeriodEnd
      : null;
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
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.orderSummary;
      })}
    >
      {/* Without a change there is nothing to compare, and the ledger above
          already carries the current totals. */}
      {hasConfigurationChange && (
        <ManagedSubscriptionComparison
          currentTotals={currentTotals}
          management={management}
          plan={plan}
          totals={totals}
        />
      )}
      {scheduledDowngradeEffectiveAt ? (
        <ScheduledUsagePackDowngradeNotice
          effectiveAt={scheduledDowngradeEffectiveAt}
        />
      ) : (
        hasDowngrade &&
        management.currentPeriodEnd && (
          <SubscriptionChangeNotice
            description={i18n.t(($) => {
              return $.billing.plans.usagePacks.management.downgradeDescription;
            })}
            effectiveAt={management.currentPeriodEnd}
          />
        )
      )}
      {hasPendingChange && !hasScheduledDowngrade && (
        <p className="mt-3 text-sm text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.processing;
          })}
        </p>
      )}
      {hasSubscriptionAction && (
        <div className={STEP_ACTION_BAR}>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="button"
            className="h-10 w-full text-sm font-medium"
            disabled={
              !members ||
              (hasPendingChange && !hasScheduledDowngrade) ||
              previewing
            }
            onClick={() => {
              detach(openPreview(), Reason.DomCallback);
            }}
          >
            {managedSubscriptionActionLabel({
              previewing,
              restoresScheduledDowngrade,
            })}
          </Button>
        </div>
      )}
    </section>
  );
}

function PackageConfigurationStep({
  catalog,
  management,
  plan,
  preview,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly management: UsagePackManagementResponse | null;
  readonly plan: UsagePackPlan;
  readonly preview: UsagePackSubscriptionChangePreviewResponse | null;
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

  /* The review reads the packages configured here, so it stays in this step's
     component and reuses the totals rather than resolving the member list a
     second time. */
  if (preview) {
    return <PackageReviewStep plan={plan} preview={preview} totals={totals} />;
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <MemberUsageConfiguration
        catalog={catalog}
        management={management}
        members={members}
        pendingMembers={paidPendingMembers}
        plan={plan}
        totals={totals}
      />
      {/* The frame keeps step 1's height, so a short member list leaves slack
          below the ledger. Spend it above the fine print and the action, which
          stay together at the foot of the dialog. */}
      <div className="mt-auto flex flex-col gap-3.5">
        <MemberUsageFooter />
        {management ? (
          <ManagedSubscriptionOrderSummary
            currentTotals={managedMemberUsageTotals(
              management,
              members,
              catalog,
            )}
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
          />
        )}
      </div>
    </div>
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
  const preview = useGet(usagePackMigrationPreview$);
  const previewing = previewLoadable.state === "loading" || preview !== null;
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
  const preview = useGet(usagePackMigrationRevisionPreview$);
  const previewing = previewLoadable.state === "loading" || preview !== null;
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
      <ManagedSubscriptionSummaryDetails
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
  inDialog = false,
  onBack,
  onSelect,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly inDialog?: boolean;
  readonly onBack: () => void;
  readonly onSelect: (tier: UsagePackPlanTier) => void;
}) {
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  const setMemberUsageSelections = useSet(setMemberUsageSelections$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const resolveAction = (
    targetTier: UsagePackPlanTier,
  ): PlanSelectionAction => {
    return configuration
      ? usagePackPlanAction(
          false,
          configuration.tier,
          configuration.tier,
          targetTier,
        )
      : "convert";
  };
  const selectPlan = (targetTier: UsagePackPlanTier): void => {
    setMemberUsageSelections(
      configuration ? migrationConfigurationSelections(configuration) : {},
    );
    onSelect(targetTier);
  };

  if (inDialog) {
    return catalog ? (
      <PlanSelectionStep
        catalog={catalog}
        onAction={(targetTier) => {
          selectPlan(targetTier);
        }}
        resolveAction={resolveAction}
      />
    ) : (
      <div className="m-5 flex-1 animate-pulse rounded-xl bg-muted/40" />
    );
  }

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
        <PlanSelectionPanel>
          {USAGE_PACK_PLANS.map((plan, index) => {
            const action = resolveAction(plan.tier);
            return (
              <PlanSelectionCard
                key={plan.tier}
                action={action}
                busy={false}
                catalog={catalog}
                divided={index > 0}
                plan={plan}
                onAction={() => {
                  selectPlan(plan.tier);
                }}
              />
            );
          })}
        </PlanSelectionPanel>
      )}
    </div>
  );
}

export function UsagePackMigrationPage({
  configuration,
  effectiveAt,
  inDialog = false,
  migrationId,
  onBack,
  sourceTier,
  targetTier,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly effectiveAt: string;
  readonly inDialog?: boolean;
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
      className={`flex flex-col gap-5 outline-none ${
        inDialog ? "flex-1 pb-5" : ""
      }`}
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      {!catalog ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : (
        <>
          {!inDialog && <PricingPageHeader onBack={onBack} step={2} />}
          <MemberUsageConfiguration
            catalog={catalog}
            management={null}
            members={members}
            plan={plan}
            totals={totals}
          />
          <MemberUsageFooter />
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

export function UsagePackMigrationDialogs({
  migration,
  migrationOpen,
  migrationTargetTier,
  onBack,
  onClose,
  onSelect,
}: {
  readonly migration: UsagePackMigrationStateResponse;
  readonly migrationOpen: boolean;
  readonly migrationTargetTier: UsagePackPlanTier | null;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onSelect: (tier: UsagePackPlanTier) => void;
}) {
  const resetPricing = useSet(resetUsagePackPricing$);
  const configurationStep =
    migrationOpen &&
    migrationTargetTier !== null &&
    migration.effectiveAt !== null
      ? {
          effectiveAt: migration.effectiveAt,
          targetTier: migrationTargetTier,
        }
      : null;
  const configuring = configurationStep !== null;
  return (
    <PricingStepDialog
      flush={!configuring}
      step={configuring ? 2 : 1}
      total={2}
      onBack={configuring ? onBack : undefined}
      onClose={() => {
        resetPricing();
        onClose();
      }}
    >
      {configurationStep ? (
        <UsagePackMigrationPage
          configuration={migration.configuration ?? null}
          effectiveAt={configurationStep.effectiveAt}
          inDialog
          migrationId={migration.migrationId}
          onBack={onBack}
          sourceTier={migration.tier}
          targetTier={configurationStep.targetTier}
        />
      ) : (
        <UsagePackMigrationPlanSelectionPage
          configuration={migration.configuration ?? null}
          inDialog
          onBack={onClose}
          onSelect={onSelect}
        />
      )}
    </PricingStepDialog>
  );
}

export function UsagePackPricingDialogs({
  checkoutAllowed,
  currentTier,
  onClose,
}: {
  readonly checkoutAllowed: boolean;
  readonly currentTier: BillingTier;
  readonly onClose: () => void;
}) {
  const selectedPlanTier = useGet(selectedUsagePackPlan$);
  const setSelectedPlan = useSet(setSelectedUsagePackPlan$);
  const setMemberUsageSelections = useSet(setMemberUsageSelections$);
  const changePreview = useGet(usagePackSubscriptionChangePreview$);
  const closePreview = useSet(closeUsagePackSubscriptionChangePreview$);
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
  /* Only a managed subscription reviews its change here; a checkout leaves for
     Stripe from the configuration step, so it has no third step to count. */
  const preview = management === null ? null : changePreview;
  const reviewing = selectedPlan !== undefined && preview !== null;
  return (
    <PricingStepDialog
      flush={!selectedPlan}
      step={reviewing ? 3 : selectedPlan ? 2 : 1}
      total={management === null ? 2 : 3}
      onBack={
        reviewing
          ? closePreview
          : selectedPlan
            ? () => {
                setSelectedPlan(null);
              }
            : undefined
      }
      onClose={() => {
        closePreview();
        setSelectedPlan(null);
        onClose();
      }}
    >
      {!catalog || !managementLoaded ? (
        <div
          className={`flex-1 animate-pulse rounded-xl bg-muted/40 ${
            selectedPlan ? "mb-5" : "m-5"
          }`}
        />
      ) : selectedPlan ? (
        <PackageConfigurationStep
          catalog={catalog}
          management={management}
          plan={selectedPlan}
          preview={preview}
        />
      ) : (
        <PlanSelectionStep
          catalog={catalog}
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
          resolveAction={(targetTier) => {
            return usagePackPlanAction(
              checkoutAllowed,
              currentTier,
              management?.tier ?? null,
              targetTier,
            );
          }}
        />
      )}
    </PricingStepDialog>
  );
}
