import { useState } from "react";
import { useLoadable, useSet } from "ccstate-react";
import type { OrgMember, MemberUsage } from "@vm0/core";
import { IconUsers } from "@tabler/icons-react";
import { Input, Popover, PopoverAnchor, PopoverContent } from "@vm0/ui";
import { usageMembersAsync$ } from "../../../../signals/usage-page/usage-signals.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  billingStatusAsync$,
  type BillingTier,
} from "../../../../signals/zero-page/billing.ts";
import { setMemberCreditCap$ } from "../../../../signals/zero-page/member-credit-caps.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

const cardBoxStyle = {
  ...sectionCardStyle,
  borderRadius: "0.75rem",
  backgroundColor: "hsl(var(--card))",
} as const;

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

function splitCreditsForBar(
  balance: number,
  tier: BillingTier,
): { planPortion: number; rolloverPortion: number } {
  const ref = tierCreditReference(tier);
  if (balance <= 0 || ref <= 0) {
    return { planPortion: Math.max(0, balance), rolloverPortion: 0 };
  }
  return {
    planPortion: Math.min(balance, ref),
    rolloverPortion: Math.max(0, balance - ref),
  };
}

function CreditUsageBar({
  used,
  balance,
  tier,
}: {
  used: number;
  balance: number;
  tier: BillingTier;
}) {
  const ref = tierCreditReference(tier);
  const total = used + balance;
  const barMax = Math.max(total, ref, 1);

  // Three segments: used | plan pool (remaining within plan) | rollover (above plan)
  const usedPct = (used / barMax) * 100;
  const { planPortion, rolloverPortion } = splitCreditsForBar(balance, tier);
  const planPct = (planPortion / barMax) * 100;
  const rolloverPct = (rolloverPortion / barMax) * 100;

  const [open, setOpen] = useState(false);
  const [timerId, setTimerId] = useState<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);

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
            {planPortion > 0 && (
              <div
                className="h-full shrink-0 bg-primary/25"
                style={{ width: `${planPct}%` }}
              />
            )}
            {rolloverPortion > 0 && (
              <div
                className="h-full shrink-0 bg-amber-500/30"
                style={{ width: `${rolloverPct}%` }}
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
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="text-sm font-medium text-foreground">Credit breakdown</p>
        <ul className="mt-2.5 space-y-2 text-xs text-muted-foreground">
          <li className="relative flex items-baseline justify-between pl-5">
            <span
              className="absolute left-0 top-[0.35em] h-2 w-2 rounded-full bg-primary"
              aria-hidden
            />
            <span>Used this period</span>
            <span className="tabular-nums text-foreground">
              {used.toLocaleString()}
            </span>
          </li>
          <li className="relative flex items-baseline justify-between pl-5">
            <span
              className="absolute left-0 top-[0.35em] h-2 w-2 rounded-full bg-primary/25"
              aria-hidden
            />
            <span>Plan pool remaining</span>
            <span className="tabular-nums text-foreground">
              {planPortion.toLocaleString()}
            </span>
          </li>
          {rolloverPortion > 0 && (
            <li className="relative flex items-baseline justify-between pl-5">
              <span
                className="absolute left-0 top-[0.35em] h-2 w-2 rounded-full bg-amber-500/50"
                aria-hidden
              />
              <span>Rollover &amp; extra</span>
              <span className="tabular-nums text-foreground">
                {rolloverPortion.toLocaleString()}
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

function apiTierToBillingTier(tier: string | undefined): BillingTier {
  if (tier === "free" || tier === "pro" || tier === "team") {
    return tier;
  }
  return "free";
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

function InlineCapInput({
  member,
  onSaved,
}: {
  member: MemberUsage;
  onSaved: (cap: number | null) => void;
}) {
  const updateCap = useSet(setMemberCreditCap$);
  const [value, setValue] = useState(
    member.creditCap !== null ? String(member.creditCap) : "",
  );
  const [saving, setSaving] = useState(false);

  const commit = () => {
    const trimmed = value.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) {
      return;
    }
    if (cap === member.creditCap) {
      return;
    }

    setSaving(true);
    detach(
      (async () => {
        await updateCap({ userId: member.userId, creditCap: cap });
        onSaved(cap);
        setSaving(false);
      })().catch(() => {
        setSaving(false);
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
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
      disabled={saving}
      className="h-8 w-full text-[13px] tabular-nums placeholder:text-xs"
    />
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col" style={cardBoxStyle}>
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
        <span className="h-4 w-32 rounded bg-muted/50 animate-pulse" />
        <span className="ml-auto h-4 w-16 rounded bg-muted/30 animate-pulse" />
      </div>
      <div className="h-px bg-border/40 mx-5" />
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
        <span className="h-4 w-40 rounded bg-muted/40 animate-pulse" />
        <span className="ml-auto h-4 w-12 rounded bg-muted/30 animate-pulse" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrgUsageTab() {
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

  const orgMembers =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const memberMap = new Map(orgMembers.map((m) => [m.userId, m]));

  const period = usageData?.period ?? null;
  const [members, setMembers] = useState<MemberUsage[]>([]);

  // Sync from loadable to local state for optimistic cap updates
  const rawMembers = usageData?.members ?? [];
  const rawKey = rawMembers
    .map((m) => `${m.userId}:${m.creditsCharged}`)
    .join(",");
  const [prevKey, setPrevKey] = useState("");
  if (rawKey !== prevKey) {
    setPrevKey(rawKey);
    setMembers(
      rawMembers.slice().sort((a, b) => b.creditsCharged - a.creditsCharged),
    );
  }

  const totalUsed = members.reduce((s, m) => s + m.creditsCharged, 0);

  const handleCapSaved = (userId: string, cap: number | null) => {
    setMembers((prev) =>
      prev.map((m) => (m.userId === userId ? { ...m, creditCap: cap } : m)),
    );
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Credit balance */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Credit balance</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
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
            className="rounded-xl bg-card px-5 py-8 text-center text-sm text-muted-foreground"
            style={sectionCardStyle}
          >
            Failed to load usage. Please try again later.
          </div>
        ) : !period ? (
          <div
            className="rounded-xl bg-card px-5 py-8 text-center text-sm text-muted-foreground"
            style={sectionCardStyle}
          >
            No active billing period. Credit usage by member is available on
            paid plans.
          </div>
        ) : members.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 rounded-xl bg-card px-5 py-10 text-center"
            style={sectionCardStyle}
          >
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
          <div
            className="overflow-hidden rounded-xl bg-card"
            style={sectionCardStyle}
          >
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
                  <div className="h-px bg-border/40 mx-5" />
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
                      <InlineCapInput
                        member={member}
                        onSaved={(cap) => handleCapSaved(member.userId, cap)}
                      />
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
        )}
      </section>
    </div>
  );
}
