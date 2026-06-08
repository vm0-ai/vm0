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
  UsageRecordRow,
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
  loadMoreUsageRecord$,
  usageRecordAsync$,
  usageSourceFilter$,
} from "../../../../signals/zero-page/settings/personal-usage-record.ts";
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

// Sources offered in the filter. Others still appear under "All sources".
const FILTER_OPTIONS = [
  "chat",
  "schedule",
  "slack",
  "telegram",
  "other",
] as const satisfies readonly UsageRecordSource[];

const ROW_CLASS =
  "flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-[hsl(var(--gray-50))] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50";

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
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

function usageRowKey(row: UsageRecordRow): string {
  return `${row.source}:${row.threadId ?? row.runId ?? row.lastActivityAt}`;
}

export function SourceFilter({
  value,
  onChange,
}: {
  value: UsageRecordSource | null;
  onChange: (source: UsageRecordSource | null) => void;
}) {
  const label = value ? SOURCE_META[value].label : "All sources";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 shrink-0 rounded-lg border"
        >
          {label}
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="ml-1.5 text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={() => {
            onChange(null);
          }}
        >
          All sources
        </DropdownMenuItem>
        {FILTER_OPTIONS.map((source) => {
          return (
            <DropdownMenuItem
              key={source}
              onClick={() => {
                onChange(source);
              }}
            >
              {SOURCE_META[source].label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageRow({ row }: { row: UsageRecordRow }) {
  const { label, Icon } = SOURCE_META[row.source];
  const title = row.title && row.title.length > 0 ? row.title : "Untitled";
  const credits = `${formatCredits(row.credits)} credits`;
  const inner = (
    <>
      <span
        title={label}
        aria-label={label}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground"
      >
        <Icon size={17} stroke={1.5} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {title}
      </span>
      <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {formatDate(row.lastActivityAt)}
      </span>
      <span className="shrink-0 whitespace-nowrap text-right text-sm font-medium text-foreground tabular-nums">
        {credits}
      </span>
    </>
  );

  if (row.threadId) {
    return (
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: row.threadId } }}
        className={ROW_CLASS}
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
            <span className="h-4 w-20 rounded bg-muted/40" />
            <span className="h-4 w-40 rounded bg-muted/50" />
            <span className="ml-auto h-3 w-10 rounded bg-muted/30" />
            <span className="h-4 w-12 rounded bg-muted/40" />
          </div>
        );
      })}
    </div>
  );
}

export function PersonalUsageRecord() {
  const loadable = useLastLoadable(usageRecordAsync$);
  const loadMore = useSet(loadMoreUsageRecord$);
  const filter = useGet(usageSourceFilter$);

  return (
    <section className="flex flex-col gap-4">
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn&apos;t load your usage record. Please try again later.
        </p>
      )}
      {loadable.state === "hasData" &&
        (loadable.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {filter
              ? "No usage from this source yet."
              : "No usage yet. Your runs will show up here as you use credits."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="overflow-hidden rounded-xl bg-card"
              style={{ border: CARD_BORDER }}
            >
              {loadable.data.rows.map((row) => {
                return <UsageRow key={usageRowKey(row)} row={row} />;
              })}
            </div>
            {loadable.data.rows.length < loadable.data.pagination.total && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 rounded-lg text-muted-foreground hover:bg-[hsl(var(--gray-50))] hover:text-foreground"
                  onClick={() => {
                    loadMore();
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
