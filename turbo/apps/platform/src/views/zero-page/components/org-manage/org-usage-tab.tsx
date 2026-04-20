import { useGet, useLoadable, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { createPortal } from "react-dom";
import { FeatureSwitchKey, type OrgMember, type MemberUsage } from "@vm0/core";
import { IconUsers, IconPencil, IconLoader2 } from "@tabler/icons-react";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { Button, Input } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { usageMembersAsync$ } from "../../../../signals/usage-page/usage-signals.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { UsageInsightView } from "../../../usage-page/components/usage-insight-view.tsx";
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

function UnsavedBar({
  onDiscard,
  onSave,
  saving,
}: {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const container = document.getElementById("org-manage-content");
  if (!container) {
    return null;
  }
  return createPortal(
    <div className="absolute bottom-6 left-0 right-0 z-10 flex justify-center px-4">
      <div
        data-testid="unsaved-bar"
        className="zero-card flex max-w-md items-center justify-between gap-4 px-5 py-4 shadow-lg"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <IconPencil
            size={18}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
          <span>You have unsaved changes</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            data-testid="discard-button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDiscard}
            disabled={saving}
          >
            Discard
          </Button>
          <Button
            data-testid="save-button"
            size="sm"
            className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? (
              <IconLoader2
                size={14}
                stroke={1.5}
                className="animate-spin mr-1.5"
              />
            ) : null}
            Save
          </Button>
        </div>
      </div>
    </div>,
    container,
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
            <div className="px-5 py-4" data-testid="credit-balance-info">
              <p className="text-sm font-medium tabular-nums text-foreground">
                {billing.credits.toLocaleString()}
              </p>
            </div>
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
  const features = useLastResolved(featureSwitch$);
  const analyticsEnabled = features?.[FeatureSwitchKey.UsageAnalytics] ?? false;

  if (analyticsEnabled) {
    return <UsageInsightView />;
  }

  return <OverviewSection />;
}
