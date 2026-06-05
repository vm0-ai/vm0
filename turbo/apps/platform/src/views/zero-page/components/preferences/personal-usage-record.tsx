import { useLastLoadable, useSet } from "ccstate-react";
import type { UsageRecordChatRow } from "@vm0/api-contracts/contracts/zero-usage-record";
import { Button } from "@vm0/ui";
import {
  loadMoreUsageRecord$,
  usageRecordAsync$,
} from "../../../../signals/zero-page/settings/personal-usage-record.ts";
import { Link } from "../../../router/link.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";

const CARD_BORDER = "0.7px solid hsl(var(--gray-400))";

function formatCredits(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

// "Today" / "Yesterday" / "Jun 1, 2026" for a chat's most recent activity.
function dayLabel(date: Date, todayStart: number): string {
  const dayStart = startOfLocalDay(date);
  const diffDays = Math.round((todayStart - dayStart) / 86_400_000);
  if (diffDays <= 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

// Time of day for today's rows, otherwise the calendar date.
function rowWhen(date: Date, todayStart: number): string {
  const isToday = startOfLocalDay(date) >= todayStart;
  if (isToday) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

interface DayGroup {
  label: string;
  chats: UsageRecordChatRow[];
}

// Rows arrive newest-first, so grouping consecutively preserves time order.
function groupByDay(chats: UsageRecordChatRow[]): DayGroup[] {
  const todayStart = startOfLocalDay(new Date());
  const groups: DayGroup[] = [];
  for (const chat of chats) {
    const label = dayLabel(new Date(chat.lastActivityAt), todayStart);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.chats.push(chat);
    } else {
      groups.push({ label, chats: [chat] });
    }
  }
  return groups;
}

function UsageRecordRow({ chat }: { chat: UsageRecordChatRow }) {
  const todayStart = startOfLocalDay(new Date());
  const when = rowWhen(new Date(chat.lastActivityAt), todayStart);
  const title =
    chat.threadTitle && chat.threadTitle.length > 0
      ? chat.threadTitle
      : "Untitled chat";
  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: chat.threadId } }}
      className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-[hsl(var(--gray-50))] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/50"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {when}
      </span>
      <span className="w-16 shrink-0 text-right text-sm font-medium text-foreground tabular-nums">
        {chat.credits > 0 ? `−${formatCredits(chat.credits)}` : "0"}
      </span>
    </Link>
  );
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

  return (
    <section className="flex flex-col gap-4">
      <SettingsSectionHeading
        title="Usage record"
        description="What each chat has spent, newest first."
      />
      {loadable.state === "loading" && <UsageRecordSkeleton />}
      {loadable.state === "hasError" && (
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn&apos;t load your usage record. Please try again later.
        </p>
      )}
      {loadable.state === "hasData" &&
        (loadable.data.chats.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No usage yet. Your chats will show up here as you use credits.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groupByDay(loadable.data.chats).map((group) => {
              return (
                <div key={group.label} className="flex flex-col gap-2">
                  <p className="px-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                  <div
                    className="overflow-hidden rounded-xl bg-card"
                    style={{ border: CARD_BORDER }}
                  >
                    {group.chats.map((chat) => {
                      return <UsageRecordRow key={chat.threadId} chat={chat} />;
                    })}
                  </div>
                </div>
              );
            })}
            {loadable.data.chats.length < loadable.data.pagination.total && (
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
