import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { OrgMember } from "@vm0/core/contracts/org-members";
import type { BillingStatusResponse } from "@vm0/core/contracts/zero-billing";
import type { MemberUsage } from "@vm0/core/contracts/zero-usage";
import { IconUsers } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { toast } from "@vm0/ui/components/ui/sonner";
import { UnsavedBar } from "./unsaved-bar.tsx";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { usageMembersAsync$ } from "../../../../signals/usage-page/usage-signals.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  billingStatusAsync$,
  apiTierToBillingTier,
} from "../../../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  inlineCapValues$,
  setInlineCapValue$,
  usageMembers$,
  syncUsageMembersFromLoadable$,
  inlineCapBatchCommit$,
  inlineCapsDirty$,
  discardAllInlineCapValues$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

// ---------------------------------------------------------------------------
// Credit breakdown bar chart
// ---------------------------------------------------------------------------

type CreditSegment = BillingStatusResponse["creditBreakdown"][number];

// Segment swatches map to theme tokens defined in
// `turbo/apps/platform/src/views/css/index.css` under `@theme`. Keep the
// mapping here purely symbolic so branding/dark-mode tweaks happen in CSS.
const CATEGORY_COLORS: Readonly<
  Record<Exclude<CreditSegment["category"], "plan">, string>
> = {
  free: "bg-credit-free",
  promotional: "bg-credit-promotional",
  payAsYouGo: "bg-credit-pay-as-you-go",
};

const PLAN_COLORS: Readonly<
  Record<NonNullable<CreditSegment["tier"]>, string>
> = {
  pro: "bg-credit-plan-pro",
  team: "bg-credit-plan-team",
};

function colorForSegment(seg: CreditSegment): string {
  if (seg.category === "plan") {
    return seg.tier ? PLAN_COLORS[seg.tier] : "bg-credit-plan-pro";
  }
  return CATEGORY_COLORS[seg.category];
}

const CATEGORY_DESCRIPTIONS: Readonly<
  Record<Exclude<CreditSegment["category"], "plan">, string>
> = {
  free: "Starter credits, use until depleted",
  promotional: "Campaign credits, expires after a set period",
  payAsYouGo: "Auto-recharge credits, never expire",
};

function segmentKey(seg: CreditSegment): string {
  // `buildCreditBreakdown` keys segments by `category:tier`, so the same
  // composite is stable and unique across the array.
  return seg.tier ? `${seg.category}:${seg.tier}` : seg.category;
}

function descriptionForSegment(
  seg: CreditSegment,
  currentTier: string,
): string {
  if (seg.category !== "plan") {
    return CATEGORY_DESCRIPTIONS[seg.category];
  }
  if (seg.tier === currentTier) {
    return "Monthly plan credits, resets each billing cycle";
  }
  return "Leftover credits from previous plan";
}

function CreditBalanceChart({ billing }: { billing: BillingStatusResponse }) {
  const segments = billing.creditBreakdown.filter((s) => {
    return s.credits > 0;
  });
  const total = billing.credits;

  return (
    <div className="px-5 py-4" data-testid="credit-balance-info">
      <p className="text-sm font-medium tabular-nums text-foreground">
        {total.toLocaleString()}
      </p>

      {total > 0 && segments.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {/* Bar */}
          <TooltipProvider delayDuration={100}>
            <div className="flex h-2.5 w-full rounded-full bg-muted/40">
              {segments.map((s) => {
                const color = colorForSegment(s);
                const desc = descriptionForSegment(s, billing.tier);
                return (
                  <Tooltip key={segmentKey(s)}>
                    <TooltipTrigger asChild>
                      <div
                        className={`h-2.5 ${color} cursor-default first:rounded-l-full last:rounded-r-full ring-0 hover:ring-2 hover:ring-foreground/30 hover:z-10 transition-shadow`}
                        style={{
                          width: `${(s.credits / total) * 100}%`,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      style={{ backgroundColor: "white", color: "inherit" }}
                      className="border shadow-md"
                    >
                      <div className="font-medium text-foreground">
                        {s.label} — {s.credits.toLocaleString()}
                      </div>
                      <div className="text-muted-foreground mt-0.5">{desc}</div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {segments.map((s) => {
              const color = colorForSegment(s);
              return (
                <div
                  key={segmentKey(s)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
                  />
                  <span>{s.label}</span>
                  <span className="tabular-nums">
                    {s.credits.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
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
  const capValues = useGet(inlineCapValues$);
  const setCapValue = useSet(setInlineCapValue$);
  const value = capValues.has(member.userId)
    ? capValues.get(member.userId)!
    : member.creditCap !== null
      ? String(member.creditCap)
      : "";

  return (
    <Input
      type="text"
      inputMode="numeric"
      placeholder="No limit"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== "" && !/^\d+$/.test(v)) {
          return;
        }
        setCapValue(member.userId, v);
      }}
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

  const isDirty = useGet(inlineCapsDirty$);
  const discardAll = useSet(discardAllInlineCapValues$);
  const pageSignal = useGet(pageSignal$);
  const [batchLoadable, doBatchCommit] = useLoadableSet(inlineCapBatchCommit$);
  const batchSaving = batchLoadable.state === "loading";

  const handleSave = () => {
    detach(
      doBatchCommit(members, pageSignal).catch(() => {
        toast.error("Failed to update credit caps. Please try again.");
      }),
      Reason.DomCallback,
    );
  };

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
            <CreditBalanceChart billing={billing} />
          ) : (
            <div className="px-5 py-4">
              <p className="text-sm text-muted-foreground">
                Credit balance unavailable.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Members — only for paid plans */}
      {currentTier !== "free" && (
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
      )}

      {isDirty && (
        <UnsavedBar
          onDiscard={discardAll}
          onSave={handleSave}
          saving={batchSaving}
        />
      )}
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
      <div className="grid grid-cols-[1fr_7rem_6rem_8.5rem] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
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
            <div className="grid grid-cols-[1fr_7rem_6rem_8.5rem] gap-x-4 items-center px-5 py-3">
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
              <span className="text-[13px] tabular-nums text-foreground whitespace-nowrap">
                {member.creditsCharged.toLocaleString()}
              </span>
              <span className="text-[13px] tabular-nums text-muted-foreground/50 whitespace-nowrap">
                {remaining !== null ? remaining.toLocaleString() : "–"}
              </span>
              {isAdmin ? (
                <InlineCapInput member={member} />
              ) : (
                <span className="text-[13px] tabular-nums text-muted-foreground whitespace-nowrap">
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
  return <OverviewSection />;
}
