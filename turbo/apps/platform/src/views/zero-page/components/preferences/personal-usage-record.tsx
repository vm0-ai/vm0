import type { MouseEvent, PointerEvent } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
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
import { getModelDisplayName } from "@vm0/core/model-display-name";
import type { OrgMember } from "@vm0/api-contracts/contracts/org-members";
import type {
  UsageRecordKind,
  UsageRecordRange,
  UsageRecordResponse,
  UsageRecordRow,
  UsageRecordScope,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import type { UsageMembersResponse } from "@vm0/api-contracts/contracts/zero-usage";
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
  teamMemberUsageAsync$,
} from "../../../../signals/zero-page/settings/personal-usage-record.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { setSettingsDialogOpen$ } from "../../../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { nowDate } from "../../../../lib/time.ts";
import { Link } from "../../../router/link.tsx";
import { MemberUsageTable } from "../org-manage/org-usage-tab.tsx";

const CARD_BORDER = "0.7px solid hsl(var(--gray-400))";

const SOURCE_META = {
  chat: { label: "Chat", Icon: IconMessageCircle },
  automation: { label: "Automation", Icon: IconClock },
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
    tooltipLabel: "LLM",
    color: "bg-usage-kind-model",
  },
  image: {
    label: "Image models",
    tooltipLabel: "Image",
    color: "bg-usage-kind-image",
  },
  video: {
    label: "Video models",
    tooltipLabel: "Video",
    color: "bg-usage-kind-video",
  },
  connector: {
    label: "Connectors",
    tooltipLabel: "Connectors",
    color: "bg-usage-kind-connector",
  },
  other: {
    label: "Other",
    tooltipLabel: "Other",
    color: "bg-usage-kind-other",
  },
} as const satisfies Record<
  UsageRecordKind,
  { label: string; tooltipLabel: string; color: string }
>;

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

// Row divider is an inset hairline (pseudo-element with horizontal margin) so
// it doesn't run edge-to-edge into the card border.
const ROW_CLASS =
  "relative block px-5 py-3.5 transition-colors hover:bg-[hsl(var(--gray-50))] [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-5 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:border-t [&:not(:first-child)]:before:border-border/50 [&:not(:first-child)]:before:content-['']";

type UsageRecordLoadable =
  | { readonly state: "loading" }
  | { readonly state: "hasError" }
  | { readonly state: "hasData"; readonly data: UsageRecordResponse };

type UsageMembersLoadable =
  | { readonly state: "loading" }
  | { readonly state: "hasError" }
  | { readonly state: "hasData"; readonly data: UsageMembersResponse };

function formatCredits(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

const USAGE_PROVIDER_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "gpt-image-1": "GPT Image 1",
  "gpt-image-1-mini": "GPT Image 1 Mini",
  "gpt-image-1.5": "GPT Image 1.5",
  "gpt-image-2": "GPT Image 2",
  "flux-pro/v1.1": "FLUX Pro 1.1",
  "flux-pro/v1.1-ultra": "FLUX Pro 1.1 Ultra",
  "qwen-image": "Qwen Image",
  "bytedance/seedream/v4/text-to-image": "Seedream 4",
  "nano-banana-2": "Nano Banana 2",
  "nanobanana-2": "Nano Banana 2",
  "veo3.1/fast": "Veo 3.1 Fast",
  "kling-video/v3/4k/text-to-video": "Kling Video v3 4K",
  "dreamina-seedance-2-0-260128": "Seedance 2.0",
  "dreamina-seedance-2-0-fast-260128": "Seedance 2.0 Fast",
  "seedance-1-5-pro-251215": "Seedance 1.5 Pro",
};

const KNOWN_VENDOR_PREFIXES = [
  "fal-ai/",
  "fal/",
  "openai/",
  "anthropic/",
  "google/",
  "deepseek/",
  "moonshotai/",
  "minimax/",
  "zai/",
  "z-ai/",
] as const;

const UPPERCASE_USAGE_TOKENS = [
  "ai",
  "api",
  "cli",
  "glm",
  "gpt",
  "id",
  "llm",
  "sql",
  "tts",
  "url",
  "vm0",
] as const;

function stripUsageProviderVendor(value: string): string {
  const lower = value.toLowerCase();
  const prefix = KNOWN_VENDOR_PREFIXES.find((knownPrefix) => {
    return lower.startsWith(knownPrefix);
  });
  return prefix ? value.slice(prefix.length) : value;
}

function titleCaseUsageToken(token: string): string {
  const lower = token.toLowerCase();
  if (
    UPPERCASE_USAGE_TOKENS.some((uppercaseToken) => {
      return uppercaseToken === lower;
    })
  ) {
    return lower.toUpperCase();
  }
  if (/^v\d+(?:\.\d+)*$/u.test(lower)) {
    return lower.toUpperCase();
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatUsageIdentifier(value: string): string {
  return value
    .split(/[/._-]+/u)
    .filter((token) => {
      return token.length > 0;
    })
    .map(titleCaseUsageToken)
    .join(" ");
}

function formatUsageProviderLabel(
  kind: UsageRecordKind,
  provider: string,
): string {
  if (provider.trim().length === 0) {
    return "Unknown";
  }
  if (kind !== "model" && kind !== "image" && kind !== "video") {
    return provider;
  }

  const normalized = provider.trim();
  const knownDisplayName = getModelDisplayName(normalized);
  if (knownDisplayName !== normalized) {
    return knownDisplayName;
  }

  const withoutVendor = stripUsageProviderVendor(normalized);
  const override =
    USAGE_PROVIDER_LABEL_OVERRIDES[normalized] ??
    USAGE_PROVIDER_LABEL_OVERRIDES[withoutVendor];
  return override ?? formatUsageIdentifier(withoutVendor);
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

function stopUsageTooltipPropagation(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
): void {
  event.stopPropagation();
}

function UsageBreakdownLegend({ row }: { row: UsageRecordRow }) {
  const segments = row.breakdown.filter((segment) => {
    return segment.credits > 0;
  });
  if (row.credits <= 0 || segments.length === 0) {
    return null;
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
      {segments.map((segment) => {
        const meta = KIND_META[segment.kind];
        return (
          <Tooltip key={segment.kind}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex min-h-6 cursor-default items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-50))] hover:text-foreground"
                data-testid={`usage-kind-legend-${segment.kind}`}
              >
                <span
                  className={`${meta.color} h-2 w-2 shrink-0 rounded-full`}
                />
                <span className="tabular-nums">
                  {segment.credits.toLocaleString()}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={8}
              style={{
                backgroundColor: "hsl(var(--popover))",
                color: "hsl(var(--popover-foreground))",
              }}
              className="pointer-events-auto max-w-64 select-text border shadow-md"
              onClick={stopUsageTooltipPropagation}
              onMouseDown={stopUsageTooltipPropagation}
              onMouseUp={stopUsageTooltipPropagation}
              onPointerDown={stopUsageTooltipPropagation}
              onPointerUp={stopUsageTooltipPropagation}
            >
              <div className="font-medium text-foreground">
                {meta.tooltipLabel} {segment.credits.toLocaleString()}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {segment.providers.map((provider) => {
                  return (
                    <div
                      key={provider.provider}
                      className="flex min-w-0 justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span className="truncate">
                        {formatUsageProviderLabel(
                          segment.kind,
                          provider.provider,
                        )}
                      </span>
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
  const credits = formatCredits(row.credits);
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
        <UsageBreakdownLegend row={row} />
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

// Summary + type legend above the list. The credit total is range-wide (from
// the server), so it stays correct as more pages load in.
function UsageRecordSummary({
  count,
  totalCredits,
}: {
  count: number;
  totalCredits: number;
}) {
  const kinds = Object.keys(KIND_META) as UsageRecordKind[];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          {count} {count === 1 ? "chat" : "chats"}
        </span>{" "}
        · {formatCredits(totalCredits)} credits
      </p>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {kinds.map((kind) => {
          return (
            <span
              key={kind}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className={`${KIND_META[kind].color} h-2 w-2 shrink-0 rounded-full`}
              />
              {KIND_META[kind].label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function UsageRecordList({
  data,
  scope,
}: {
  data: UsageRecordResponse;
  scope: UsageRecordScope;
}) {
  const loadMore = useSet(loadMoreUsageRecord$);

  return (
    <div className="flex flex-col gap-3">
      <TooltipProvider delayDuration={100}>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={{ border: CARD_BORDER }}
        >
          <UsageRecordSummary
            count={data.pagination.total}
            totalCredits={data.totalCredits}
          />
          {data.rows.map((row) => {
            return <UsageRow key={usageRowKey(row)} row={row} />;
          })}
        </div>
      </TooltipProvider>
      {data.rows.length < data.pagination.total && (
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
  );
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
          <UsageRecordList data={loadable.data} scope={scope} />
        ))}
    </section>
  );
}

function TeamMemberUsageContent({
  loadable,
  range,
}: {
  loadable: UsageMembersLoadable;
  range: UsageRecordRange;
}) {
  const membersLoadable = useLoadable(orgMembers$);
  const orgMembersList =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const memberMap = new Map<string, OrgMember>(
    orgMembersList.map((member) => {
      return [member.userId, member];
    }),
  );

  return (
    <section className="flex flex-col gap-4">
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn&apos;t load team usage. Please try again later.
        </p>
      )}
      {loadable.state === "hasData" &&
        (!loadable.data.period ? (
          <p className="text-sm text-muted-foreground">
            No active billing period. Team usage is available on paid plans.
          </p>
        ) : loadable.data.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage(range)}</p>
        ) : (
          <MemberUsageTable
            members={loadable.data.members}
            memberMap={memberMap}
          />
        ))}
    </section>
  );
}

export function PersonalUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(myUsageRecordAsync$);
  return <UsageRecordContent loadable={loadable} range={range} scope="mine" />;
}

export function TeamUsageRecord({ range }: { range: UsageRecordRange }) {
  const loadable = useLastLoadable(teamMemberUsageAsync$);
  return <TeamMemberUsageContent loadable={loadable} range={range} />;
}
