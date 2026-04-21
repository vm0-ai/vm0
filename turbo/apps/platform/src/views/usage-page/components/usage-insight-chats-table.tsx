import type { UsageInsightResponse } from "@vm0/core";
import type { InsightMetric } from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function UsageInsightChatsTable({
  data,
  metric,
}: {
  data: UsageInsightResponse;
  metric: InsightMetric;
}) {
  const { chats, chatOtherCount, chatOtherCredits } = data;

  if (chats.length === 0 && chatOtherCount === 0) {
    return (
      <div className="rounded-xl bg-card zero-border px-5 py-8 text-center text-sm text-muted-foreground">
        No chats in this period
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-card zero-border">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
        <span>Chat thread</span>
        <span>{metric === "credits" ? "Credits" : "Tokens"}</span>
      </div>
      {chats.map((row) => {
        return (
          <div key={row.threadId}>
            <div className="h-0 zero-border-t mx-5" />
            <Link
              pathname="/chats/:threadId"
              options={{ pathParams: { threadId: row.threadId } }}
              className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-3 transition-colors hover:bg-muted/30"
            >
              <span className="truncate text-sm text-foreground">
                {row.threadTitle ?? "(untitled)"}
              </span>
              <span className="text-[13px] tabular-nums text-foreground whitespace-nowrap">
                {metric === "credits"
                  ? formatValue(row.credits)
                  : formatValue(row.tokens)}
              </span>
            </Link>
          </div>
        );
      })}
      {chatOtherCount > 0 && (
        <div>
          <div className="h-0 zero-border-t mx-5" />
          <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-3">
            <span className="text-sm text-muted-foreground">
              +{chatOtherCount} more chats
            </span>
            {metric === "credits" && (
              <span className="text-[13px] tabular-nums text-muted-foreground whitespace-nowrap">
                {formatValue(chatOtherCredits)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
