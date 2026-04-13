import { useGet, useLoadable, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey, type OrgMember, type MemberUsage } from "@vm0/core";
import { IconUsers } from "@tabler/icons-react";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import {
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  usageMembersAsync$,
  usageTab$,
  setUsageTab$,
  type UsageTab,
} from "../../../../signals/usage-page/usage-signals.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { CreditsChart } from "../../../usage-page/components/credits-chart.tsx";
import { RunsTab } from "../../../usage-page/components/runs-tab.tsx";
import {
  billingStatusAsync$,
  apiTierToBillingTier,
  type BillingTier,
} from "../../../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  creditBarPopoverOpen$,
  setCreditBarPopoverOpen$,
  creditBarTimerId$,
  setCreditBarTimerId$,
  inlineCapValues$,
  setInlineCapValue$,
  usageMembers$,
  syncUsageMembersFromLoadable$,
  inlineCapCommit$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

// ---------------------------------------------------------------------------
// Credit balance bar (moved from billing tab)
// ---------------------------------------------------------------------------

function tierCreditReference(tier: BillingTier): number {
  if (tier === "free") {
    return 10_000;
  }
  if (tier === "pro") {
    return 20_000;
  }
  return 120_000;
}

function formatCreditsLine(tier: BillingTier, totalUsed: number): string {
  const monthly = tierCreditReference(tier);
  if (monthly <= 0) {
    return `Used ${totalUsed.toLocaleString()} credits`;
  }
  return `${monthly.toLocaleString()}/mo plan · used ${totalUsed.toLocaleString()} this period`;
}

function CreditUsageBar({
  used,
  balance,
  tier,
  creditExpiry,
}: {
  used: number;
  balance: number;
  tier: BillingTier;
  creditExpiry?: { expiringNextCycle: number; nextExpiryDate: string | null };
}) {
  const ref = tierCreditReference(tier);
  const total = used + balance;
  const barMax = Math.max(total, ref, 1);

  const usedPct = (used / barMax) * 100;

  const open = useGet(creditBarPopoverOpen$);
  const setOpen = useSet(setCreditBarPopoverOpen$);
  const timerId = useGet(creditBarTimerId$);
  const setTimerId = useSet(setCreditBarTimerId$);

  const show = () => {
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
      setTimerId(null);
    }
    setOpen(true);
  };

  const scheduleHide = () => {
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
    }
    setTimerId(
      globalThis.setTimeout(() => {
        setOpen(false);
        setTimerId(null);
      }, 200),
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (!v && timerId !== null) {
          globalThis.clearTimeout(timerId);
          setTimerId(null);
        }
        setOpen(v);
      }}
      modal={false}
    >
      <PopoverAnchor asChild>
        <div
          className="group w-full cursor-default py-1.5 -my-1.5"
          data-testid="credit-bar-hover-target"
          onPointerEnter={show}
          onPointerLeave={scheduleHide}
        >
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/70 ring-offset-background transition-shadow group-hover:ring-2 group-hover:ring-ring/35 group-hover:ring-offset-1"
            role="progressbar"
            aria-valuenow={Math.round(usedPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${used.toLocaleString()} used, ${balance.toLocaleString()} remaining`}
            aria-label="Credit usage this period"
          >
            {used > 0 && (
              <div
                className="h-full shrink-0 bg-primary"
                style={{ width: `${usedPct}%` }}
              />
            )}
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className="w-72 p-3 text-left shadow-lg"
        onPointerEnter={show}
        onPointerLeave={scheduleHide}
        onOpenAutoFocus={(e) => {
          return e.preventDefault();
        }}
      >
        <p className="text-sm font-medium text-foreground">Credit breakdown</p>
        <ul className="mt-2.5 space-y-2 text-xs text-muted-foreground">
          {creditExpiry &&
            creditExpiry.expiringNextCycle > 0 &&
            creditExpiry.nextExpiryDate && (
              <li className="relative flex items-baseline justify-between pl-5">
                <span
                  className="absolute left-0 top-[0.35em] h-2 w-2 rounded-full bg-orange-500/50"
                  aria-hidden
                />
                <span className="text-orange-600 dark:text-orange-400">
                  Expiring on{" "}
                  {new Date(creditExpiry.nextExpiryDate).toLocaleDateString(
                    "en-US",
                  )}
                </span>
                <span className="tabular-nums text-orange-600 dark:text-orange-400">
                  {creditExpiry.expiringNextCycle.toLocaleString()}
                </span>
              </li>
            )}
        </ul>
        {ref > 0 && (
          <p className="mt-2.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground leading-snug">
            {ref.toLocaleString()} credits/mo plan allocation. Credits above
            this are rollover from prior periods or top-ups.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MemberAvatar({
  imageUrl,
  initial,
  name,
}: {
  imageUrl: string;
  initial: string;
  name: string;
}) {
  if (imageUrl) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden">
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function InlineCapInput({ member }: { member: MemberUsage }) {
  const pageSignal = useGet(pageSignal$);
  const capValues = useGet(inlineCapValues$);
  const setCapValue = useSet(setInlineCapValue$);
  const value = capValues.has(member.userId)
    ? capValues.get(member.userId)!
    : member.creditCap !== null
      ? String(member.creditCap)
      : "";
  const [loadable, doCommit] = useLoadableSet(inlineCapCommit$);
  const saving = loadable.state === "loading";

  const commit = () => {
    const trimmed = value.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) {
      return;
    }

    detach(
      doCommit(
        {
          userId: member.userId,
          creditCap: cap,
          memberCreditCap: member.creditCap,
        },
        pageSignal,
      ).catch(() => {
        toast.error("Failed to update credit cap. Please try again.");
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Input
      type="number"
      min={1}
      step={1}
      placeholder="No limit"
      value={value}
      onChange={(e) => {
        return setCapValue(member.userId, e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        }
      }}
      disabled={saving}
      className="h-8 w-full text-[13px] tabular-nums placeholder:text-xs"
    />
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col rounded-xl bg-card zero-border">
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
        <span className="h-4 w-32 rounded bg-muted/50 animate-pulse" />
        <span className="ml-auto h-4 w-16 rounded bg-muted/30 animate-pulse" />
      </div>
      <div className="h-0 zero-border-t mx-5" />
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
        <span className="h-4 w-40 rounded bg-muted/40 animate-pulse" />
        <span className="ml-auto h-4 w-12 rounded bg-muted/30 animate-pulse" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview section
// ---------------------------------------------------------------------------

function OverviewSection() {
  const usageLoadable = useLoadable(usageMembersAsync$);
  const membersLoadable = useLoadable(orgMembers$);
  const adminLoadable = useLoadable(isOrgAdmin$);
  const billingLoadable = useLoadable(billingStatusAsync$);

  const isAdmin =
    adminLoadable.state === "hasData" ? adminLoadable.data : false;

  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const billingLoading = billingLoadable.state === "loading";
  const currentTier = apiTierToBillingTier(billing?.tier);

  const usageLoading = usageLoadable.state === "loading";
  const usageError = usageLoadable.state === "hasError";
  const usageData =
    usageLoadable.state === "hasData" ? usageLoadable.data : null;

  const orgMembersList =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const memberMap = new Map(
    orgMembersList.map((m) => {
      return [m.userId, m];
    }),
  );

  const period = usageData?.period ?? null;
  const members = useGet(usageMembers$);

  // Sync from loadable to signal state for optimistic cap updates
  const rawMembers = usageData?.members ?? [];
  useSet(syncUsageMembersFromLoadable$)(rawMembers);

  const totalUsed = members.reduce((s, m) => {
    return s + m.creditsCharged;
  }, 0);

  return (
    <div className="flex flex-col gap-8">
      {/* Credit balance */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Credit balance</h3>
        <div className="overflow-hidden rounded-xl bg-card zero-border">
          {billingLoading && !billing ? (
            <div className="px-5 py-4 space-y-2">
              <div className="h-4 w-48 rounded bg-muted/50 animate-pulse" />
              <div className="h-1.5 w-full rounded-full bg-muted/40 animate-pulse" />
            </div>
          ) : billing ? (
            <>
              <div className="px-5 py-4">
                <p className="text-sm font-medium text-foreground">
                  {billing.credits.toLocaleString()} credits
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  {formatCreditsLine(currentTier, totalUsed)}
                </p>
              </div>
              <div className="px-5 pb-4 pt-1">
                <CreditUsageBar
                  used={totalUsed}
                  balance={billing.credits}
                  tier={currentTier}
                  creditExpiry={billing.creditExpiry}
                />
              </div>
            </>
          ) : (
            <div className="px-5 py-4">
              <p className="text-sm text-muted-foreground">
                Credit balance unavailable.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Members */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Members</h3>

        {usageLoading && !usageData ? (
          <LoadingSkeleton />
        ) : usageError ? (
          <div
            className="rounded-xl bg-card px-5 py-8 text-center text-sm text-muted-foreground zero-border"
            data-testid="usage-tab-error"
            role="alert"
          >
            Failed to load usage. Please try again later.
          </div>
        ) : !period ? (
          <div className="rounded-xl bg-card px-5 py-8 text-center text-sm text-muted-foreground zero-border">
            No active billing period. Credit usage by member is available on
            paid plans.
          </div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-card px-5 py-10 text-center zero-border">
            <IconUsers
              size={20}
              stroke={1.5}
              className="text-muted-foreground"
            />
            <p className="text-sm text-muted-foreground">
              No usage yet this period
            </p>
          </div>
        ) : (
          <MembersTable
            members={members}
            memberMap={memberMap}
            isAdmin={isAdmin}
          />
        )}
      </section>
    </div>
  );
}

function MembersTable({
  members,
  memberMap,
  isAdmin,
}: {
  members: MemberUsage[];
  memberMap: Map<string, OrgMember>;
  isAdmin: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-card zero-border">
      {/* Header */}
      <div className="grid grid-cols-[1fr_7rem_6rem_5.5rem] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
        <span>Member</span>
        <span>Used</span>
        <span>Remaining</span>
        <span>Limit cap</span>
      </div>
      {members.map((member) => {
        const orgMember = memberMap.get(member.userId);
        const name = orgMember ? displayName(orgMember) : "";
        const label = name || member.email;
        const initial = label.charAt(0).toUpperCase();
        const remaining =
          member.creditCap !== null
            ? Math.max(0, member.creditCap - member.creditsCharged)
            : null;

        return (
          <div key={member.userId}>
            <div className="h-0 zero-border-t mx-5" />
            <div className="grid grid-cols-[1fr_7rem_6rem_5.5rem] gap-x-4 items-center px-5 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <MemberAvatar
                  imageUrl={orgMember?.imageUrl ?? ""}
                  initial={initial}
                  name={label}
                />
                <div className="min-w-0">
                  {name ? (
                    <>
                      <p className="truncate text-sm font-medium text-foreground">
                        {name}
                      </p>
                      <p className="truncate text-[13px] text-muted-foreground">
                        {member.email}
                      </p>
                    </>
                  ) : (
                    <p className="truncate text-sm font-medium text-foreground">
                      {member.email}
                    </p>
                  )}
                </div>
              </div>
              <span className="text-[13px] tabular-nums text-foreground">
                {member.creditsCharged.toLocaleString()}
              </span>
              <span className="text-[13px] tabular-nums text-muted-foreground/50">
                {remaining !== null ? remaining.toLocaleString() : "–"}
              </span>
              {isAdmin ? (
                <InlineCapInput member={member} />
              ) : (
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {member.creditCap !== null
                    ? member.creditCap.toLocaleString()
                    : "—"}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrgUsageTab() {
  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    adminLoadable.state === "hasData" ? adminLoadable.data : false;

  const tab = useGet(usageTab$);
  const setTab = useSet(setUsageTab$);
  const handleTabChange = (value: string) => {
    setTab(value as UsageTab);
  };

  const features = useLastResolved(featureSwitch$);
  const analyticsEnabled = features?.[FeatureSwitchKey.UsageAnalytics] ?? false;

  if (!isAdmin || !analyticsEnabled) {
    return <OverviewSection />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
          <TabsTrigger
            value="overview"
            className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="daily"
            className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
          >
            Daily
          </TabsTrigger>
          <TabsTrigger
            value="runs"
            className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
          >
            Runs
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "overview" && <OverviewSection />}
      {tab === "daily" && <CreditsChart />}
      {tab === "runs" && <RunsTab />}
    </div>
  );
}
