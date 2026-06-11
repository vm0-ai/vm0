import type { MouseEvent } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import {
  IconBrandGithub,
  IconBrandSlack,
  IconBrandTelegram,
  IconChevronDown,
  IconClock,
  IconMail,
  IconMessageCircle,
  IconPhone,
  IconRobot,
  IconTerminal2,
} from "@tabler/icons-react";
import type {
  UsageRecordKind,
  UsageRecordRange,
  UsageRecordResponse,
  UsageRecordRow,
  UsageRecordScope,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  loadMoreUsageRecord$,
  myUsageRecordAsync$,
  teamUsageRecordAsync$,
} from "../../../../signals/zero-page/settings/personal-usage-record.ts";
import { setSettingsDialogOpen$ } from "../../../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { nowDate } from "../../../../lib/time.ts";
import { Link } from "../../../router/link.tsx";

const CARD_BORDER = "0.7px solid hsl(var(--gray-400))";

const SOURCE_META = {
  chat: { label: "Chat", Icon: IconMessageCircle },
  schedule: { label: "Schedule", Icon: IconClock },
  slack: { label: "Slack", Icon: IconBrandSlack },
  telegram: { label: "Telegram", Icon: IconBrandTelegram },
  email: { label: "Email", Icon: IconMail },
  agentphone: { label: "Phone", Icon: IconPhone },
  github: { label: "GitHub", Icon: IconBrandGithub },
  cli: { label: "CLI", Icon: IconTerminal2 },
  agent: { label: "Agent", Icon: IconRobot },
  other: { label: "Other", Icon: IconRobot },
} as const satisfies Record<
  UsageRecordSource,
  { label: string; Icon: typeof IconMessageCircle }
>;

const KIND_META = {
  model: {
    label: "LLM models",
    color: "bg-usage-kind-model",
  },
  image: {
    label: "Image models",
    color: "bg-usage-kind-image",
  },
  video: {
    label: "Video models",
    color: "bg-usage-kind-video",
  },
  connector: {
    label: "Connectors",
    color: "bg-usage-kind-connector",
  },
  other: {
    label: "Other",
    color: "bg-usage-kind-other",
  },
} as const satisfies Record<UsageRecordKind, { label: string; color: string }>;

const RANGE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "billingPeriod", label: "Billing period" },
] as const satisfies readonly {
  value: UsageRecordRange;
  label: string;
}[];

const ROW_CLASS =
  "block px-5 py-3.5 transition-colors hover:bg-[hsl(var(--gray-50))] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50";

type UsageRecordLoadable =
  | { readonly state: "loading" }
  | { readonly state: "hasError" }
  | { readonly state: "hasData"; readonly data: UsageRecordResponse };

function formatCredits(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === nowDate().getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

function rangeLabel(range: UsageRecordRange): string {
  return (
    RANGE_OPTIONS.find((option) => {
      return option.value === range;
    })?.label ?? "Today"
  );
}

function usageRowKey(row: UsageRecordRow): string {
  return `${row.source}:${row.threadId ?? row.runId ?? row.lastActivityAt}:${row.member?.userId ?? "mine"}`;
}

export function UsageRangeSelect({
  value,
  onChange,
}: {
  value: UsageRecordRange;
  onChange: (range: UsageRecordRange) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 shrink-0 rounded-lg border"
        >
          {rangeLabel(value)}
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="ml-1.5 text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {RANGE_OPTIONS.map((option) => {
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => {
                onChange(option.value);
              }}
            >
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageBreakdownBar({ row }: { row: UsageRecordRow }) {
  const segments = row.breakdown.filter((segment) => {
    return segment.credits > 0;
  });
  if (row.credits <= 0 || segments.length === 0) {
    return null;
  }

  return (
    <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-muted/40">
      {segments.map((segment) => {
        const meta = KIND_META[segment.kind];
        const width = `${(segment.credits / row.credits) * 100}%`;
        return (
          <Tooltip key={segment.kind}>
            <TooltipTrigger asChild>
              <div
                className={`${meta.color} h-2 cursor-default first:rounded-l-full last:rounded-r-full transition-shadow hover:z-10 hover:ring-2 hover:ring-foreground/30`}
                style={{ width }}
                data-testid={`usage-kind-segment-${segment.kind}`}
              />
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={8}
              style={{
                backgroundColor: "hsl(var(--popover))",
                color: "hsl(var(--popover-foreground))",
              }}
              className="max-w-64 border shadow-md"
            >
              <div className="font-medium text-foreground">
                {meta.label} - {segment.credits.toLocaleString()}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {segment.providers.map((provider) => {
                  return (
                    <div
                      key={provider.provider}
                      className="flex min-w-0 justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span className="truncate">{provider.provider}</span>
                      <span className="shrink-0 tabular-nums">
                        {provider.credits.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function UsageRow({ row }: { row: UsageRecordRow }) {
  const closeSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const { label, Icon } = SOURCE_META[row.source];
  const title = row.title && row.title.length > 0 ? row.title : "Untitled";

  const closeOnNavigate = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      return;
    }
    detach(closeSettings(false, pageSignal), Reason.DomCallback);
  };
  const credits = `${formatCredits(row.credits)} credits`;
  const inner = (
    <div className="flex min-w-0 items-start gap-3">
      <span
        title={label}
        aria-label={label}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground"
      >
        <Icon size={17} stroke={1.5} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            {formatDate(row.lastActivityAt)}
          </span>
          <span className="shrink-0 whitespace-nowrap text-right text-sm font-medium text-foreground tabular-nums">
            {credits}
          </span>
        </span>
        {row.member ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {row.member.email}
          </span>
        ) : null}
        <UsageBreakdownBar row={row} />
      </span>
    </div>
  );

  if (row.threadId) {
    return (
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: row.threadId } }}
        className={ROW_CLASS}
        onClick={closeOnNavigate}
      >
        {inner}
      </Link>
    );
  }
  if (row.runId) {
    return (
      <Link
        pathname="/activities/:activityRunId"
        options={{ pathParams: { activityRunId: row.runId } }}
        className={ROW_CLASS}
        onClick={closeOnNavigate}
      >
        {inner}
      </Link>
    );
  }
  return <div className={ROW_CLASS}>{inner}</div>;
}

function UsageRecordSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-xl bg-card"
      style={{ border: CARD_BORDER }}
    >
      {[0, 1, 2].map((i) => {
        return (
          <div
            key={i}
            className="flex animate-pulse items-center gap-3 px-5 py-3.5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
          >
            <span className="h-8 w-8 rounded-lg bg-muted/40" />
            <span className="min-w-0 flex-1">
              <span className="block h-4 w-40 rounded bg-muted/50" />
              <span className="mt-2 block h-2 w-full rounded bg-muted/30" />
            </span>
            <span className="h-4 w-12 rounded bg-muted/40" />
          </div>
        );
      })}
    </div>
  );
}

function emptyMessage(range: UsageRecordRange): string {
  if (range === "billingPeriod") {
    return "No billing period usage yet.";
  }
  return "No usage for this range yet.";
}

function UsageRecordContent({
  loadable,
  range,
  scope,
}: {
  loadable: UsageRecordLoadable;
  range: UsageRecordRange;
  scope: UsageRecordScope;
}) {
  const loadMore = useSet(loadMoreUsageRecord$);

  return (
    <section className="flex flex-col gap-4">
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn&apos;t load usage. Please try again later.
        </p>
      )}
      {loadable.state === "hasData" &&
        (loadable.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage(range)}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <TooltipProvider delayDuration={100}>
              <div
                className="overflow-hidden rounded-xl bg-card"
                style={{ border: CARD_BORDER }}
              >
                {loadable.data.rows.map((row) => {
                  return <UsageRow key={usageRowKey(row)} row={row} />;
                })}
              </div>
            </TooltipProvider>
            {loadable.data.rows.length < loadable.data.pagination.total && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 rounded-lg text-muted-foreground hover:bg-[hsl(var(--gray-50))] hover:text-foreground"
                  onClick={() => {
                    loadMore(scope);
                  }}
                >
                  Load more
                </Button>
              </div>
            )}
          </div>
        ))}
    </section>
  );
}

export function PersonalUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(myUsageRecordAsync$);
  return <UsageRecordContent loadable={loadable} range={range} scope="mine" />;
}

export function TeamUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(teamUsageRecordAsync$);
  return <UsageRecordContent loadable={loadable} range={range} scope="team" />;
}
