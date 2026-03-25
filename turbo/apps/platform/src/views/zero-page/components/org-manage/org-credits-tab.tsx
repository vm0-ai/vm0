import { useState } from "react";
import { useLastLoadable, useSet } from "ccstate-react";
import { billingStatusAsync$ } from "../../../../signals/zero-page/billing.ts";
import { usageMembersAsync$ } from "../../../../signals/usage-page/usage-signals.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  memberCreditCaps$,
  setMemberCreditCap$,
} from "../../../../signals/zero-page/member-credit-caps.ts";
import { Button, Input } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function MemberCapEditor({
  userId,
  currentCap,
}: {
  userId: string;
  currentCap: number | null;
}) {
  const setCap = useSet(setMemberCreditCap$);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentCap?.toString() ?? "");

  const handleSave = () => {
    const parsed = value.trim() === "" ? null : Number.parseInt(value, 10);
    if (parsed !== null && (Number.isNaN(parsed) || parsed <= 0)) {
      return;
    }
    setCap({ userId, creditCap: parsed }).catch(() => {
      toast.error("Failed to update credit cap. Please try again.");
    });
    setEditing(false);
  };

  const handleClear = () => {
    setCap({ userId, creditCap: null }).catch(() => {
      toast.error("Failed to clear credit cap. Please try again.");
    });
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(currentCap?.toString() ?? "");
          setEditing(true);
        }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {currentCap !== null ? formatNumber(currentCap) : "No limit"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-20 text-xs"
        placeholder="No limit"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSave();
          }
          if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs px-2"
        onClick={handleSave}
      >
        Save
      </Button>
      {currentCap !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={handleClear}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

export function OrgCreditsTab() {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const usageLoadable = useLastLoadable(usageMembersAsync$);
  const capsLoadable = useLastLoadable(memberCreditCaps$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const credits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const tier =
    billingLoadable.state === "hasData" ? billingLoadable.data.tier : null;
  const periodEnd =
    billingLoadable.state === "hasData"
      ? billingLoadable.data.currentPeriodEnd
      : null;

  const members =
    usageLoadable.state === "hasData" ? usageLoadable.data.members : [];
  const totalUsage = members.reduce((sum, m) => sum + m.creditsCharged, 0);

  const caps = capsLoadable.state === "hasData" ? capsLoadable.data : new Map();

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Usage</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Credit balance
              </span>
              <span className="text-[13px] text-muted-foreground">
                Credits available for AI usage
              </span>
            </div>
            <span className="text-lg font-semibold text-foreground tabular-nums shrink-0">
              {credits !== null ? formatNumber(credits) : "--"}
            </span>
          </div>
          <div className="h-px bg-border/40 mx-5" />
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Usage this period
              </span>
              <span className="text-[13px] text-muted-foreground">
                {periodEnd
                  ? `Current billing period ends ${new Date(periodEnd).toLocaleDateString()}`
                  : "Total credits consumed in the current billing period"}
              </span>
            </div>
            <span className="text-sm text-muted-foreground tabular-nums shrink-0">
              {formatNumber(totalUsage)}
            </span>
          </div>
          {tier !== null && tier !== "free" && (
            <>
              <div className="h-px bg-border/40 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    Plan
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {tier.charAt(0).toUpperCase() + tier.slice(1)} tier
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {members.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-foreground">Member usage</h3>
          <div
            className="overflow-hidden rounded-xl bg-card"
            style={sectionCardStyle}
          >
            <div className="grid grid-cols-[1fr_6rem_6rem] gap-x-4 px-5 py-3 text-sm font-medium text-foreground">
              <div>Member</div>
              <div className="text-right">Credits used</div>
              {isAdmin && <div className="text-right">Cap</div>}
            </div>
            {members.map((member, i) => {
              const cap = caps.get(member.userId);
              return (
                <div key={member.userId}>
                  {i === 0 && <div className="h-px bg-border/40 mx-5" />}
                  {i > 0 && <div className="h-px bg-border/40 mx-5" />}
                  <div className="grid grid-cols-[1fr_6rem_6rem] gap-x-4 items-center px-5 py-3">
                    <span className="text-sm text-muted-foreground truncate">
                      {member.email}
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums text-right">
                      {formatNumber(member.creditsCharged)}
                    </span>
                    {isAdmin && (
                      <div className="flex justify-end">
                        <MemberCapEditor
                          userId={member.userId}
                          currentCap={cap?.creditCap ?? null}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
