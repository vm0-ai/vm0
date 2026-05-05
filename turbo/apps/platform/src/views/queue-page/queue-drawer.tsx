import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Button,
} from "@vm0/ui";
import { IconCrown } from "@tabler/icons-react";
import {
  queueDrawerOpen$,
  setQueueDrawerOpen$,
} from "../../signals/queue-page/queue-drawer-state.ts";
import { queueData$ } from "../../signals/queue-page/queue-signals.ts";
import { startCheckout$ } from "../../signals/zero-page/billing.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// Upgrade path config: free → pro, pro → team
// ---------------------------------------------------------------------------

interface UpgradePath {
  targetTier: "pro" | "team";
  targetLabel: string;
  concurrentRuns: number;
  price: string;
  description: string;
  features: readonly string[];
}

const UPGRADE_PATHS = {
  free: {
    targetTier: "pro",
    targetLabel: "Pro",
    concurrentRuns: 2,
    price: "$20",
    description: "Run multiple tasks in parallel and skip the queue.",
    features: [
      "20,000 credits / month",
      "Pay as you go after that",
      "2 concurrent runs",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Email support",
    ],
  },
  pro: {
    targetTier: "team",
    targetLabel: "Team",
    concurrentRuns: 10,
    price: "$200",
    description: "Scale your team with 10 parallel runs and more credits.",
    features: [
      "120,000 credits / month",
      "Pay as you go after that",
      "10 concurrent runs",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Priority support",
    ],
  },
} as const satisfies Record<string, UpgradePath>;

// ---------------------------------------------------------------------------
// Check icon matching plan comparison page
// ---------------------------------------------------------------------------

function CheckCircleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted-foreground/40"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="16 9 10.5 15 8 12.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Drawer content
// ---------------------------------------------------------------------------

function QueueDrawerContent() {
  const dataLoadable = useLastLoadable(queueData$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const checkoutLoading = checkoutLoadable.state === "loading";

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-24 animate-pulse rounded-xl bg-muted/20" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/20" />
      </div>
    );
  }

  const { concurrency } = data;
  const tierLabel =
    concurrency.tier.charAt(0).toUpperCase() + concurrency.tier.slice(1);
  const upgrade =
    concurrency.tier in UPGRADE_PATHS
      ? UPGRADE_PATHS[concurrency.tier as keyof typeof UPGRADE_PATHS]
      : undefined;

  const tierColor = "text-[#D27939]";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Current plan status */}
      <div className="shrink-0 rounded-xl zero-border p-5">
        <p
          className={`text-sm font-semibold uppercase tracking-wider font-mono mb-3 ${tierColor}`}
        >
          {tierLabel}
        </p>
        <div className="flex items-center gap-2 mb-2">
          {Array.from({ length: concurrency.limit }, (_, i) => {
            const filled = i < concurrency.active;
            return (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full ${filled ? "bg-destructive" : "bg-muted"}`}
              />
            );
          })}
        </div>
        <p className="text-lg font-medium text-foreground">
          {concurrency.active} of {concurrency.limit} slot
          {concurrency.limit !== 1 ? "s" : ""} in use
        </p>
        <p className="text-[13px] font-light text-muted-foreground leading-relaxed mt-1.5">
          {concurrency.available === 0
            ? `You can only run ${concurrency.limit} task${concurrency.limit !== 1 ? "s" : ""} at a time. New runs will wait in a queue until one finishes.`
            : `${concurrency.available} slot${concurrency.available !== 1 ? "s" : ""} available`}
        </p>
      </div>

      {/* Upsell to next tier */}
      {upgrade && (
        <div className="flex-1 flex flex-col rounded-xl zero-border p-5">
          <div className="flex items-start justify-between mb-2">
            <h3
              className={`text-sm font-semibold uppercase tracking-wider font-mono ${tierColor}`}
            >
              {upgrade.targetLabel}
            </h3>
            <span className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
              <IconCrown size={12} stroke={1.8} className="text-amber-500" />
              Recommended
            </span>
          </div>

          <p className="text-lg font-medium text-foreground mb-1">
            {upgrade.concurrentRuns} concurrent runs
          </p>
          <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-4">
            {upgrade.description}
          </p>

          <div className="flex items-baseline gap-1.5 mb-4">
            <span className="text-2xl font-light tracking-tight text-foreground">
              {upgrade.price}
            </span>
            <span className="text-sm font-light text-muted-foreground">
              /month
            </span>
          </div>

          <ul className="flex flex-col gap-2">
            {upgrade.features.map((feature: string) => {
              return (
                <li key={feature} className="flex items-center gap-2">
                  <CheckCircleIcon />
                  <span className="text-[13px] font-light text-muted-foreground">
                    {feature}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-auto pt-5">
            <Button
              className="w-full h-11 text-sm font-medium"
              disabled={checkoutLoading}
              onClick={(e) => {
                const newTab = e.metaKey || e.ctrlKey;
                detach(
                  checkout(upgrade.targetTier, newTab, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              {checkoutLoading
                ? "Redirecting..."
                : `Upgrade to ${upgrade.targetLabel}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function QueueDrawer() {
  const open = useGet(queueDrawerOpen$);
  const setOpen = useSet(setQueueDrawerOpen$);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setOpen(false);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[400px] flex flex-col"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
        }}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>Your agent is waiting in line</SheetTitle>
          <SheetDescription>
            View your position in the queue and upgrade to skip the wait.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
          <QueueDrawerContent />
        </div>
      </SheetContent>
    </Sheet>
  );
}
