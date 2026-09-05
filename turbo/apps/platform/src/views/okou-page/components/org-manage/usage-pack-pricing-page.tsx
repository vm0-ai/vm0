import { ArrowLeft, CalendarDays, Check, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
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
} from "@okouai/api-contracts/contracts/billing";
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
} from "../../../../signals/okou-page/billing.ts";
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
} from "../../../../signals/okou-page/settings/usage-pack-pricing-state.ts";
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
  | "unavailable"
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

const USAGE_PACK_DOWNGRADE_NOTICE_CLASS =
  "border border-yellow-200/70 bg-yellow-50/70 text-yellow-800 dark:border-yellow-400/20 dark:bg-yellow-400/10 dark:text-yellow-200";

function usagePackPlan(tier: UsagePackPlanTier): UsagePackPlan {
  return tier === "pro" ? USAGE_PACK_PLANS[0] : USAGE_PACK_PLANS[1];
}

function canCheckoutUsagePackPlan(
  checkoutAllowed: boolean,
  grantedPlanCheckoutAllowed: boolean,
  currentTier: BillingTier,
  targetTier: UsagePackPlanTier,
): boolean {
  if (!checkoutAllowed || currentTier === "custom") {
    return false;
  }
  if (currentTier === targetTier) {
    return grantedPlanCheckoutAllowed;
  }
  return currentTier !== "team";
}

function usagePackPlanAction(
  checkoutAllowed: boolean,
  grantedPlanCheckoutAllowed: boolean,
  currentTier: BillingTier,
  managedTier: UsagePackPlanTier | null,
  targetTier: UsagePackPlanTier,
): PlanSelectionAction {
  if (currentTier === "custom") {
    return "unavailable";
  }
  if (managedTier === targetTier) {
    return "manage";
  }
  if (managedTier === "pro" && targetTier === "team") {
    return "upgrade";
  }
  if (managedTier === "team" && targetTier === "pro") {
    return "downgrade";
  }
  if (
    currentTier === targetTier &&
    canCheckoutUsagePackPlan(
      checkoutAllowed,
      grantedPlanCheckoutAllowed,
      currentTier,
      targetTier,
    )
  ) {
    return "manage";
  }
  return canCheckoutUsagePackPlan(
    checkoutAllowed,
    grantedPlanCheckoutAllowed,
    currentTier,
    targetTier,
  )
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

/* Both caps are printed. ORG_PLAN_ENTITLEMENT_TIER_VALUES gives Pro and Team
   exactly five differing fields, and audioDailyDurationSeconds is one of them,
   so a column that hid it would be dropping a fifth of what the upgrade buys. */
function planVoiceRequests(tier: UsagePackPlanTier): number {
  return tier === "pro" ? 300 : 500;
}

function planVoiceMinutes(tier: UsagePackPlanTier): number {
  return tier === "pro" ? 200 : 500;
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
            <span className="shrink-0 rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground okou-badge">
              {i18n.t(($) => {
                return $.settings.workspace.members.you;
              })}
            </span>
          )}
          {member.isPending && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground okou-badge">
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
      <div className="col-span-2 flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center">
          <img
            src={plan.image}
            alt=""
            loading="lazy"
            className="h-10 w-10 max-w-none object-contain"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-5 text-foreground">
            {i18n.t(
              ($) => {
                return $.billing.plans.namedPlan;
              },
              { plan: planName(plan.tier) },
            )}
          </span>
          <span className="block truncate text-[13px] leading-5 text-muted-foreground">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.memberExclusive;
            })}
          </span>
        </span>
      </div>
      <LedgerPrice value={plan.basePriceUsd} />
    </div>
  );
}

function LedgerTotalRow({
  bonusCredits,
  comparisonRows,
  credits,
  totalUsd,
}: {
  readonly bonusCredits: number;
  readonly comparisonRows?: readonly SubscriptionComparisonRow[];
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
      <span className="truncate px-3 text-sm text-foreground">
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
      {comparisonRows ? (
        <ManagedSubscriptionComparisonTooltip
          rows={comparisonRows}
          totalUsd={totalUsd}
        />
      ) : (
        <LedgerPrice strong value={totalUsd} />
      )}
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
          <p className="mt-1 truncate text-sm font-medium text-yellow-700 dark:text-yellow-300">
            {downgradeSummary}
          </p>
        )}
      </div>
      <LedgerPrice value={usagePackCatalogItem(catalog, selection).priceUsd} />
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
  comparisonRows,
  management,
  members,
  onSelectionChange,
  pendingMembers = [],
  plan,
  totals,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly comparisonRows?: readonly SubscriptionComparisonRow[];
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
        comparisonRows={comparisonRows}
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

/* Each plan keeps its complete value story in one list. Concurrency leads both
   lists, so 2 against 10 is still the first comparison without becoming a
   second visual hierarchy between the price and the bullets. Pro names three
   flagship models rather than asking "Every model" to carry the claim, then
   keeps BYOK as its own value prop.

   The built-in research APIs ship on Pro, so they sit in Pro's list. One line
   covers SEO, lead, web, and market data instead of three, which names the
   whole capability without pushing Pro's list past a scannable length.

   Team's first three rows and its voice caps are the only real entitlement
   differences: ORG_PLAN_ENTITLEMENT_TIER_VALUES varies baseConcurrencyLimit
   2/10, canBuyConcurrency, workflowWebhookAutomationAllowed, audioDailyRateLimit
   300/500 and audioDailyDurationSeconds 200/500, and nothing else.

   The middle rows are capability both plans ship. They sit here because the
   label says "Everything in Pro, built for teams" -- inherited, not exclusive.
   They are phrased as the thing the agent does rather than the setting that
   enables it: a plan column earns attention by naming an outcome, and "Choose
   which models your workspace can use" named a settings screen.

   The connector row is the one exception, and it is a promise ahead of the
   code: custom connectors are unlimited on both plans today, with the only
   check in custom-connector.service.ts being an org-admin test. It reads true
   only once ORG_PLAN_ENTITLEMENT_TIER_VALUES carries a per-tier connector
   limit and createCustomConnector$ enforces it.

   Nine rows on each side, every row a single line at this width, so the columns
   align row for row across the divider.

   The dialog is a fixed 43rem, leaving 570px for the columns, which Pro's nine
   rows sit exactly on. A tenth row has to replace one, and any row that wraps
   costs the same height as a new row. */
function planHighlights(tier: UsagePackPlanTier): readonly string[] {
  const concurrentAgents = i18n.t(
    ($) => {
      return $.billing.plans.highlights.concurrentAgents;
    },
    { slots: formatLocalizedNumber(planConcurrentSlots(tier)) },
  );
  const voiceInput = i18n.t(
    ($) => {
      return $.billing.plans.highlights.voiceInput;
    },
    {
      minutes: formatLocalizedNumber(planVoiceMinutes(tier)),
      requests: formatLocalizedNumber(planVoiceRequests(tier)),
    },
  );
  if (tier === "team") {
    return [
      concurrentAgents,
      i18n.t(($) => {
        return $.billing.plans.highlights.addOnConcurrency;
      }),
      i18n.t(($) => {
        return $.billing.plans.highlights.agentFanOut;
      }),
      i18n.t(($) => {
        return $.billing.plans.highlights.webhookAutomations;
      }),
      i18n.t(($) => {
        return $.billing.plans.highlights.liveBrowser;
      }),
      i18n.t(($) => {
        return $.billing.plans.highlights.computerUse;
      }),
      i18n.t(($) => {
        return $.billing.plans.highlights.moreConnectorsChannels;
      }),
      voiceInput,
      i18n.t(($) => {
        return $.billing.plans.highlights.supportPriority;
      }),
    ];
  }
  return [
    concurrentAgents,
    i18n.t(($) => {
      return $.billing.plans.highlights.models;
    }),
    i18n.t(($) => {
      return $.billing.plans.features.byok;
    }),
    i18n.t(($) => {
      return $.billing.plans.highlights.automations;
    }),
    i18n.t(($) => {
      return $.billing.plans.highlights.videoGeneration;
    }),
    i18n.t(($) => {
      return $.billing.plans.highlights.builtInResearchData;
    }),
    i18n.t(($) => {
      return $.billing.plans.highlights.chatIntegrations;
    }),
    voiceInput,
    i18n.t(($) => {
      return $.billing.plans.highlights.supportEmail;
    }),
  ];
}

function planHighlightsLabel(tier: UsagePackPlanTier): string {
  return tier === "team"
    ? i18n.t(
        ($) => {
          return $.billing.plans.highlights.everythingInBuiltForTeams;
        },
        { plan: planName("pro") },
      )
    : i18n.t(($) => {
        return $.billing.plans.highlights.included;
      });
}

/* Both columns open this block at the same y with a label of the same weight,
   so the lists start on one line.

   The block leads at mt-5 and rows sit 8px apart rather than 10px. Nine rows
   at the old spacing measured 589px against the 570px the dialog gives the
   columns, which cost both cards their bottom inset and left the CTAs sitting
   on the note's rule. Type size is untouched; only the air between rows moved. */
function PlanHighlights({ tier }: { readonly tier: UsagePackPlanTier }) {
  return (
    <div className="mt-5">
      <p className="text-xs font-medium text-muted-foreground">
        {planHighlightsLabel(tier)}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {planHighlights(tier).map((item) => {
          return (
            <li
              key={item}
              className="flex items-start gap-2.5 text-sm leading-snug text-foreground"
            >
              <Check
                size={15}
                aria-hidden
                className="mt-px shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">{item}</span>
            </li>
          );
        })}
      </ul>
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
    action === "unavailable"
      ? i18n.t(($) => {
          return $.billing.common.unavailable;
        })
      : action === "convert"
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
      {/* One line, so the price band under it starts at the same y in both
          columns without reserving a second line neither description needs. */}
      <p className="mt-2 min-h-[21px] text-sm leading-normal text-muted-foreground">
        {planDescription(plan.tier)}
      </p>

      <PlanPrice basePriceUsd={plan.basePriceUsd} catalog={catalog} />

      <PlanHighlights tier={plan.tier} />

      {/* The action closes the column, under everything it buys. */}
      <div className="mt-auto pt-6">
        <Button
          type="button"
          variant={plan.popular ? "default" : "outline"}
          className="h-10 w-full text-sm font-medium"
          disabled={action === "disabled" || action === "unavailable" || busy}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </article>
  );
}

/* The dialog header pairs back with close, so it draws both at the same 36px
   box and 20px glyph. */
function PricingBackButton({ onBack }: { readonly onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={onBack}
            variant="quiet"
            size="icon"
            iconSize="lg"
            aria-label={t(($) => {
              return $.billing.common.back;
            })}
          >
            <ArrowLeft size={20} />
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
   step's (plan selection) measured against its content, so it has to come down
   whenever that step gets shorter -- left at the old figure it would hold a
   band of empty column open above both actions. The body insets its content so
   no rule, tint or column runs into the frame.

   The dialog is mounted only while the flow is open, so the plan catalog and
   the subscription it loads stay owned by the flow rather than by every visit
   to the billing tab. */
function PricingStepDialog({
  children,
  flush = false,
  onBack,
  onClose,
  step,
  title,
  total,
}: {
  readonly children: ReactNode;
  readonly flush?: boolean;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly step: PricingStep;
  readonly title?: string;
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
        className="flex h-[min(43rem,calc(100dvh-4rem))] w-[calc(100vw-2rem)] max-w-[860px] flex-col gap-0 overflow-hidden p-0"
      >
        {/* The close button is an item in this row rather than a box pinned to
            the frame, so the title, the step counter and the close glyph share
            one centre line and one right inset. */}
        <DialogHeader className="h-14 flex-row shrink-0 items-center gap-3 space-y-0 border-b-[0.7px] border-[hsl(var(--gray-200))] py-0 pl-6 pr-4 text-left">
          {onBack && <PricingBackButton onBack={onBack} />}
          <DialogTitle className="min-w-0 flex-1 text-base font-medium leading-none">
            {title ?? pricingStepTitle(step)}
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
  configuresGrantedPlan,
  onCheckout,
  plan,
}: {
  readonly checkoutDisabled: boolean;
  readonly checkoutError: string | null;
  readonly checkoutLoading: boolean;
  readonly configuresGrantedPlan: boolean;
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
          : configuresGrantedPlan
            ? i18n.t(($) => {
                return $.billing.plans.usagePacks.configurePackages;
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
  configuresGrantedPlan,
  members,
  plan,
  selections,
}: {
  readonly configuresGrantedPlan: boolean;
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
      configuresGrantedPlan={configuresGrantedPlan}
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

/* A step's notice and action stay together on the frame's foot instead of
   scrolling away with the body they belong to: a long member list must never
   put the decision out of reach or leave its consequence detached above it.
   The bar spans the full frame width, so it cancels the body's inset and
   restores it inside, and its gap keeps the notice-to-button spacing stable.
   A notice already provides its own visual boundary, so only a bare action bar
   needs the rule that separates it from the scrolling content. */
const STEP_ACTION_BAR_BASE =
  "sticky bottom-0 -mx-5 mt-auto flex flex-col gap-3 bg-card px-5 py-4";
const STEP_ACTION_BAR = `${STEP_ACTION_BAR_BASE} ${REVIEW_RULE}`;
const STEP_ACTION_BAR_WITH_NOTICE = STEP_ACTION_BAR_BASE;

function stepActionBarClass(hasNotice: boolean): string {
  return hasNotice ? STEP_ACTION_BAR_WITH_NOTICE : STEP_ACTION_BAR;
}

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

function ManagedSubscriptionComparisonTooltip({
  rows,
  totalUsd,
}: {
  readonly rows: readonly SubscriptionComparisonRow[];
  readonly totalUsd: number;
}) {
  const comparisonTitle = i18n.t(($) => {
    return $.billing.plans.usagePacks.management.comparisonTitle;
  });
  const totalLabel = i18n.t(
    ($) => {
      return $.billing.plans.pricePerMonth;
    },
    { price: formatUsd(totalUsd, 0) },
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={`${comparisonTitle}: ${totalLabel}`}
          className="justify-self-end cursor-help appearance-none rounded-sm border-0 bg-transparent p-0 underline decoration-dotted decoration-foreground/40 decoration-[1px] underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LedgerPrice strong value={totalUsd} />
        </TooltipTrigger>
        <TooltipContent
          role="tooltip"
          align="end"
          collisionPadding={16}
          side="bottom"
          sideOffset={8}
          className="w-[27.5rem] max-w-[calc(100vw-2rem)] rounded-[12px] border-[0.7px] border-[hsl(var(--gray-400))] p-4 text-left font-normal"
          style={{
            backgroundColor: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            boxShadow:
              "0 2px 12px hsl(30 6% 45% / 0.05), 0 0 0 0.5px hsl(30 6% 45% / 0.025)",
          }}
        >
          <p className="text-sm font-medium text-foreground">
            {comparisonTitle}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management
                .comparisonDescription;
            })}
          </p>
          <SubscriptionComparisonTable presentation="tooltip" rows={rows} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SubscriptionComparisonTable({
  presentation = "contained",
  rows,
}: {
  readonly presentation?: "contained" | "tooltip";
  readonly rows: readonly SubscriptionComparisonRow[];
}) {
  const tooltip = presentation === "tooltip";
  return (
    <div
      className={
        tooltip
          ? "mt-3"
          : "mt-4 overflow-hidden rounded-lg border border-border/70"
      }
    >
      <table
        aria-label={i18n.t(($) => {
          return $.billing.plans.usagePacks.management.comparison;
        })}
        className={
          tooltip
            ? "w-full table-fixed text-[13px]"
            : "w-full table-fixed text-sm"
        }
      >
        {tooltip && (
          <colgroup>
            <col className="w-[48%]" />
            <col className="w-[26%]" />
            <col className="w-[26%]" />
          </colgroup>
        )}
        <thead
          className={
            tooltip
              ? "text-[13px] font-normal leading-5 text-muted-foreground"
              : "bg-muted/40 text-sm font-medium uppercase tracking-wide text-muted-foreground"
          }
        >
          <tr>
            <th
              scope="col"
              className={
                tooltip ? "pb-1 text-left" : "w-[40%] px-3 py-2 text-left"
              }
            />
            <th
              scope="col"
              className={
                tooltip ? "pb-1 text-right" : "w-[30%] px-3 py-2 text-right"
              }
            >
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.current;
              })}
            </th>
            <th
              scope="col"
              className={
                tooltip ? "pb-1 text-right" : "w-[30%] px-3 py-2 text-right"
              }
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
                  tooltip
                    ? ""
                    : `border-t border-border/60 ${monthlyTotal ? "bg-muted/20" : ""}`
                }
              >
                <th
                  scope="row"
                  className={
                    tooltip
                      ? `${monthlyTotal ? "rounded-l-md bg-gray-50 py-2 font-medium text-foreground" : "py-1.5 font-normal text-muted-foreground"} text-left`
                      : `px-3 py-2.5 text-left ${monthlyTotal ? "font-medium text-foreground" : "font-normal text-muted-foreground"}`
                  }
                >
                  {row.label}
                </th>
                <td
                  className={
                    tooltip
                      ? `${monthlyTotal ? "bg-gray-50 py-2 font-medium text-foreground" : "py-1.5 text-muted-foreground"} text-right tabular-nums`
                      : `px-3 py-2.5 text-right text-muted-foreground ${monthlyTotal ? "font-medium" : ""}`
                  }
                >
                  {row.current}
                </td>
                {/* Contained comparisons use weight to mark a changed value.
                    The tooltip keeps both columns quiet and equivalent. */}
                <td
                  className={
                    tooltip
                      ? `${monthlyTotal ? "rounded-r-md bg-gray-50 py-2 font-medium text-foreground" : "py-1.5 text-muted-foreground"} text-right tabular-nums`
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

function ScheduledBillingChangeNotice({
  className = "",
  description,
  title,
}: {
  readonly className?: string;
  readonly description: ReactNode;
  readonly title: string;
}) {
  return (
    <div
      role="status"
      aria-label={title}
      className={`flex items-center gap-3 rounded-xl p-3 ${USAGE_PACK_DOWNGRADE_NOTICE_CLASS} ${className}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-yellow-100/80 text-yellow-700 dark:bg-yellow-400/15 dark:text-yellow-300">
        <CalendarDays aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-yellow-900 dark:text-yellow-100">
          {title}
        </p>
        <div className="mt-0.5 text-sm leading-snug text-yellow-800 dark:text-yellow-200">
          {description}
        </div>
      </div>
    </div>
  );
}

function SubscriptionChangeNotice({
  className = "mt-3",
  description,
  effectiveAt,
}: {
  readonly className?: string;
  readonly description: string;
  readonly effectiveAt: string;
}) {
  return (
    <ScheduledBillingChangeNotice
      className={className}
      title={i18n.t(($) => {
        return $.billing.plans.usagePacks.migration.convertPlan;
      })}
      description={
        <>
          <span>{description}</span>{" "}
          <span className="font-medium">
            {i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.management.scheduledFor;
              },
              { date: formatBillingDate(effectiveAt) },
            )}
          </span>
        </>
      }
    />
  );
}

function UsagePackDowngradeNotice({
  className = "",
  effectiveAt,
  scheduled = false,
}: {
  readonly className?: string;
  readonly effectiveAt: string;
  readonly scheduled?: boolean;
}) {
  const title = scheduled
    ? i18n.t(($) => {
        return $.billing.plans.usagePacks.management.scheduledDowngradeTitle;
      })
    : i18n.t(($) => {
        return $.billing.plans.downgrade;
      });
  return (
    <ScheduledBillingChangeNotice
      className={className}
      title={title}
      description={i18n.t(
        ($) => {
          return $.billing.plans.usagePacks.management
            .scheduledDowngradeDescription;
        },
        { date: formatBillingDate(effectiveAt) },
      )}
    />
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
  readonly management: UsagePackManagementResponse;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
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
  management,
  members,
  plan,
  selections,
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
  const downgradeNotice = scheduledDowngradeEffectiveAt ? (
    <UsagePackDowngradeNotice
      effectiveAt={scheduledDowngradeEffectiveAt}
      scheduled
    />
  ) : (
    hasDowngrade &&
    management.currentPeriodEnd && (
      <UsagePackDowngradeNotice
        className={hasSubscriptionAction ? "" : "mb-5 mt-3"}
        effectiveAt={management.currentPeriodEnd}
      />
    )
  );
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
      className={scheduledDowngradeEffectiveAt ? "pb-5" : undefined}
    >
      {!hasSubscriptionAction && downgradeNotice}
      {hasPendingChange && !hasScheduledDowngrade && (
        <p className="mt-3 text-sm text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.processing;
          })}
        </p>
      )}
      {hasSubscriptionAction && (
        <div className={stepActionBarClass(Boolean(downgradeNotice))}>
          {downgradeNotice}
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
  configuresGrantedPlan,
  management,
  plan,
  preview,
}: {
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly configuresGrantedPlan: boolean;
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
  const comparisonRows =
    management &&
    hasUsagePackConfigurationChange(management, members, plan, selections)
      ? managedSubscriptionComparisonRows({
          currentPlan: usagePackPlan(management.tier),
          currentTotals: managedMemberUsageTotals(management, members, catalog),
          plan,
          totals,
        })
      : undefined;

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
        comparisonRows={comparisonRows}
        management={management}
        members={members}
        pendingMembers={paidPendingMembers}
        plan={plan}
        totals={totals}
      />
      {/* The frame keeps step 1's height, so a short member list leaves slack
          between the ledger and the action at the foot of the dialog. */}
      <div className="mt-auto">
        {management ? (
          <ManagedSubscriptionOrderSummary
            management={management}
            members={members}
            plan={plan}
            selections={selections}
          />
        ) : (
          <CheckoutOrderSummary
            configuresGrantedPlan={configuresGrantedPlan}
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
}: {
  readonly effectiveAt: string;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
}) {
  const pageSignal = useGet(pageSignal$);
  const [previewLoadable, previewMigration] = useLoadableSet(
    previewUsagePackMigration$,
  );
  const preview = useGet(usagePackMigrationPreview$);
  const previewing = previewLoadable.state === "loading" || preview !== null;
  const previewError = previewLoadable.state === "hasError";
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.orderSummary;
      })}
    >
      <div className={STEP_ACTION_BAR_WITH_NOTICE}>
        <SubscriptionChangeNotice
          className=""
          description={i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.confirmDescription;
          })}
          effectiveAt={effectiveAt}
        />
        {previewError && (
          <p className="text-sm text-destructive">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.error;
            })}
          </p>
        )}
        <Button
          type="button"
          className="h-10 w-full text-sm font-medium"
          disabled={!members || previewing}
          onClick={() => {
            if (!members) {
              return;
            }
            detach(
              previewMigration(
                {
                  targetTier: plan.tier,
                  memberUsagePacks: checkoutMemberUsagePacks(
                    members,
                    selections,
                  ),
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
      </div>
    </section>
  );
}

function MigrationRevisionOrderSummary({
  effectiveAt,
  hasConfigurationChange,
  members,
  migrationId,
  plan,
  requested,
}: {
  readonly effectiveAt: string;
  readonly hasConfigurationChange: boolean;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string;
  readonly plan: UsagePackPlan;
  readonly requested: readonly MemberUsagePack[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [previewLoadable, previewRevision] = useLoadableSet(
    previewUsagePackMigrationRevision$,
  );
  const preview = useGet(usagePackMigrationRevisionPreview$);
  const previewing = previewLoadable.state === "loading" || preview !== null;
  const previewError = previewLoadable.state === "hasError";
  return (
    <section
      aria-label={i18n.t(($) => {
        return $.billing.plans.usagePacks.orderSummary;
      })}
    >
      {!hasConfigurationChange && (
        <SubscriptionChangeNotice
          description={i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.confirmDescription;
          })}
          effectiveAt={effectiveAt}
        />
      )}
      {hasConfigurationChange && (
        <div className={STEP_ACTION_BAR_WITH_NOTICE}>
          <SubscriptionChangeNotice
            className=""
            description={i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.confirmDescription;
            })}
            effectiveAt={effectiveAt}
          />
          {previewError && (
            <p className="text-sm text-destructive">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.migration.error;
              })}
            </p>
          )}
          <Button
            type="button"
            className="h-10 w-full text-sm font-medium"
            disabled={!members || previewing}
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
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.review;
            })}
          </Button>
        </div>
      )}
    </section>
  );
}

function MigrationReviewDialog({
  onComplete,
  totals,
}: {
  readonly onComplete: () => void;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const preview = useGet(usagePackMigrationPreview$);
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
    onComplete();
  };
  return preview ? (
    <MigrationReviewStepContent
      confirming={confirming}
      error={error}
      onConfirm={handleConfirm}
      preview={preview}
      totals={totals}
    />
  ) : null;
}

function MigrationRevisionReviewDialog({
  members,
  migrationId,
  onComplete,
  selections,
  totals,
}: {
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string;
  readonly onComplete: () => void;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
}) {
  const pageSignal = useGet(pageSignal$);
  const preview = useGet(usagePackMigrationRevisionPreview$);
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
    onComplete();
  };
  return preview && members ? (
    <MigrationReviewStepContent
      confirming={confirming}
      error={error}
      onConfirm={handleConfirm}
      preview={preview}
      totals={totals}
    />
  ) : null;
}

function MigrationReviewStepContent({
  confirming,
  error,
  onConfirm,
  preview,
  totals,
}: {
  readonly confirming: boolean;
  readonly error: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly preview:
    | UsagePackMigrationPreviewResponse
    | UsagePackMigrationRevisionPreviewResponse;
  readonly totals: MemberUsageTotals;
}) {
  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-[13px] text-muted-foreground">
        {i18n.t(($) => {
          return $.billing.plans.usagePacks.migration.reviewDescription;
        })}
      </p>
      <ManagedSubscriptionSummaryDetails
        monthlyTotalCents={preview.nextRecurringAmountCents}
        plan={usagePackPlan(preview.targetTier)}
        totals={{
          bonusCredits: preview.bonusCredits,
          totalCredits: preview.totalCredits,
          totalUsd: totals.totalUsd,
        }}
      />
      <div className={STEP_ACTION_BAR_WITH_NOTICE}>
        <SubscriptionChangeNotice
          className=""
          description={i18n.t(($) => {
            return $.billing.plans.usagePacks.migration.confirmDescription;
          })}
          effectiveAt={preview.effectiveAt}
        />
        {error && (
          <p className="text-sm text-destructive">
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.error;
            })}
          </p>
        )}
        <Button
          type="button"
          className="h-10 w-full text-sm font-medium"
          disabled={confirming}
          onClick={() => {
            detach(onConfirm(), Reason.DomCallback);
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

interface MigrationPlanComparisonProps {
  readonly currentAmountCents: number;
  readonly nextAmountCents: number;
  readonly nextTotals: MemberUsageTotals;
  readonly sourceTier: UsagePackPlanTier;
  readonly targetTier: UsagePackPlanTier;
}

function migrationPlanComparisonRows({
  currentAmountCents,
  nextAmountCents,
  nextTotals,
  sourceTier,
  targetTier,
}: MigrationPlanComparisonProps): readonly SubscriptionComparisonRow[] {
  const rows: readonly SubscriptionComparisonRow[] = [
    {
      label: i18n.t(($) => {
        return $.billing.plans.usagePacks.planStep;
      }),
      current: (
        <span className="inline-flex items-center justify-end gap-1.5">
          <span>{planName(sourceTier)}</span>
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground okou-badge">
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

  return rows;
}

function UsagePackMigrationPlanSelectionPage({
  configuration,
  currentTier,
  onSelect,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly currentTier: BillingTier;
  readonly onSelect: (tier: UsagePackPlanTier) => void;
}) {
  const setMemberUsageSelections = useSet(setMemberUsageSelections$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const resolveAction = (
    targetTier: UsagePackPlanTier,
  ): PlanSelectionAction => {
    if (currentTier === "custom") {
      return "unavailable";
    }
    return configuration
      ? usagePackPlanAction(
          false,
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

  return catalog ? (
    <PlanSelectionStep
      catalog={catalog}
      onAction={selectPlan}
      resolveAction={resolveAction}
    />
  ) : (
    <div className="m-5 flex-1 animate-pulse rounded-xl bg-muted/40" />
  );
}

interface MigrationConfigurationViewState {
  readonly comparisonRows: readonly SubscriptionComparisonRow[] | undefined;
  readonly hasConfigurationChange: boolean;
  readonly requested: readonly MemberUsagePack[];
  readonly revising: boolean;
}

function migrationConfigurationViewState({
  catalog,
  configuration,
  members,
  migrationId,
  plan,
  selections,
  sourceTier,
  totals,
}: {
  readonly catalog: readonly UsagePackCatalogItem[] | null;
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string | null;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly sourceTier: UsagePackPlanTier;
  readonly totals: MemberUsageTotals;
}): MigrationConfigurationViewState {
  const requested = members
    ? checkoutMemberUsagePacks(members, selections)
    : [];
  if (!configuration || !migrationId) {
    return {
      comparisonRows: migrationPlanComparisonRows({
        currentAmountCents: (sourceTier === "pro" ? 20 : 200) * 100,
        nextAmountCents: (plan.basePriceUsd + totals.totalUsd) * 100,
        nextTotals: totals,
        sourceTier,
        targetTier: plan.tier,
      }),
      hasConfigurationChange: false,
      requested,
      revising: false,
    };
  }
  const hasConfigurationChange =
    members !== undefined &&
    migrationConfigurationChanged(configuration, plan.tier, requested);
  const revisionRows = catalog
    ? managedSubscriptionComparisonRows({
        currentPlan: usagePackPlan(configuration.tier),
        currentTotals: migrationConfigurationTotals(configuration, catalog),
        plan,
        totals,
      })
    : [];
  return {
    comparisonRows: hasConfigurationChange ? revisionRows : undefined,
    hasConfigurationChange,
    requested,
    revising: true,
  };
}

function UsagePackMigrationConfigurationStep({
  catalog,
  configuration,
  effectiveAt,
  members,
  migrationId,
  plan,
  selections,
  totals,
  viewState,
}: {
  readonly catalog: readonly UsagePackCatalogItem[] | null;
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly effectiveAt: string;
  readonly members: readonly MemberDisplay[] | undefined;
  readonly migrationId: string | null;
  readonly plan: UsagePackPlan;
  readonly selections: Readonly<Record<string, MemberUsageSelection>>;
  readonly totals: MemberUsageTotals;
  readonly viewState: MigrationConfigurationViewState;
}) {
  const usagePackPricingPageRef = useSet(usagePackPricingPageRef$);
  return (
    <div
      className="flex flex-col gap-5 outline-none flex-1"
      ref={usagePackPricingPageRef}
      role="group"
      tabIndex={-1}
    >
      {!catalog ? (
        <div className="h-80 animate-pulse rounded-xl bg-muted/40" />
      ) : (
        <>
          <MemberUsageConfiguration
            catalog={catalog}
            comparisonRows={viewState.comparisonRows}
            management={null}
            members={members}
            plan={plan}
            totals={totals}
          />
          <div className="mt-auto">
            {configuration && migrationId ? (
              <MigrationRevisionOrderSummary
                effectiveAt={effectiveAt}
                hasConfigurationChange={viewState.hasConfigurationChange}
                members={members}
                migrationId={migrationId}
                plan={plan}
                requested={viewState.requested}
              />
            ) : (
              <MigrationOrderSummary
                effectiveAt={effectiveAt}
                members={members}
                plan={plan}
                selections={selections}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function UsagePackMigrationPage({
  configuration,
  effectiveAt,
  migrationId,
  onComplete,
  sourceTier,
  targetTier,
}: {
  readonly configuration: UsagePackMigrationConfiguration | null;
  readonly effectiveAt: string;
  readonly migrationId: string | null;
  readonly onComplete: () => void;
  readonly sourceTier: UsagePackPlanTier;
  readonly targetTier: UsagePackPlanTier;
}) {
  const selections = useGet(memberUsageSelections$);
  const members = useUsagePackMembers();
  const migrationPreview = useGet(usagePackMigrationPreview$);
  const migrationRevisionPreview = useGet(usagePackMigrationRevisionPreview$);
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
  const viewState = migrationConfigurationViewState({
    catalog,
    configuration,
    members,
    migrationId,
    plan,
    selections,
    sourceTier,
    totals,
  });
  if (viewState.revising && migrationId && migrationRevisionPreview) {
    return (
      <MigrationRevisionReviewDialog
        members={members}
        migrationId={migrationId}
        onComplete={onComplete}
        selections={selections}
        totals={totals}
      />
    );
  }
  if (!viewState.revising && migrationPreview) {
    return <MigrationReviewDialog onComplete={onComplete} totals={totals} />;
  }
  return (
    <UsagePackMigrationConfigurationStep
      catalog={catalog}
      configuration={configuration}
      effectiveAt={effectiveAt}
      members={members}
      migrationId={migrationId}
      plan={plan}
      selections={selections}
      totals={totals}
      viewState={viewState}
    />
  );
}

export function UsagePackMigrationDialogs({
  currentTier,
  migration,
  migrationOpen,
  migrationTargetTier,
  onBack,
  onClose,
  onSelect,
}: {
  readonly currentTier: BillingTier;
  readonly migration: UsagePackMigrationStateResponse;
  readonly migrationOpen: boolean;
  readonly migrationTargetTier: UsagePackPlanTier | null;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onSelect: (tier: UsagePackPlanTier) => void;
}) {
  const resetPricing = useSet(resetUsagePackPricing$);
  const migrationPreview = useGet(usagePackMigrationPreview$);
  const migrationRevisionPreview = useGet(usagePackMigrationRevisionPreview$);
  const closeMigrationPreview = useSet(closeUsagePackMigrationPreview$);
  const closeMigrationRevisionPreview = useSet(
    closeUsagePackMigrationRevisionPreview$,
  );
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
  const revising =
    (migration.configuration ?? null) !== null &&
    migration.migrationId !== null;
  const reviewing =
    configuring &&
    (revising ? migrationRevisionPreview !== null : migrationPreview !== null);
  const closeFlow = () => {
    resetPricing();
    onClose();
  };
  return (
    <PricingStepDialog
      flush={!configuring}
      step={reviewing ? 3 : configuring ? 2 : 1}
      title={
        reviewing
          ? i18n.t(($) => {
              return $.billing.plans.usagePacks.migration.reviewTitle;
            })
          : undefined
      }
      total={3}
      onBack={
        reviewing
          ? revising
            ? closeMigrationRevisionPreview
            : closeMigrationPreview
          : configuring
            ? onBack
            : undefined
      }
      onClose={closeFlow}
    >
      {configurationStep ? (
        <UsagePackMigrationPage
          configuration={migration.configuration ?? null}
          effectiveAt={configurationStep.effectiveAt}
          migrationId={migration.migrationId}
          onComplete={closeFlow}
          sourceTier={migration.tier}
          targetTier={configurationStep.targetTier}
        />
      ) : (
        <UsagePackMigrationPlanSelectionPage
          configuration={migration.configuration ?? null}
          currentTier={currentTier}
          onSelect={onSelect}
        />
      )}
    </PricingStepDialog>
  );
}

export function UsagePackPricingDialogs({
  checkoutAllowed,
  currentTier,
  grantedPlanCheckoutAllowed,
  onClose,
  onReplaceCancellationWithPro,
}: {
  readonly checkoutAllowed: boolean;
  readonly currentTier: BillingTier;
  readonly grantedPlanCheckoutAllowed: boolean;
  readonly onClose: () => void;
  readonly onReplaceCancellationWithPro?: () => void;
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
        canCheckoutUsagePackPlan(
          checkoutAllowed,
          grantedPlanCheckoutAllowed,
          currentTier,
          plan.tier,
        ))
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
          configuresGrantedPlan={
            grantedPlanCheckoutAllowed && currentTier === selectedPlan.tier
          }
          management={management}
          plan={selectedPlan}
          preview={preview}
        />
      ) : (
        <PlanSelectionStep
          catalog={catalog}
          onAction={(plan, action) => {
            if (action === "disabled" || action === "unavailable") {
              return;
            }
            if (
              plan === "pro" &&
              action === "downgrade" &&
              onReplaceCancellationWithPro
            ) {
              onReplaceCancellationWithPro();
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
              grantedPlanCheckoutAllowed,
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
