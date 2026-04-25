import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import type { InsightMetric } from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";
import { getCardPalette } from "../../../lib/card-palette.ts";

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
  const { bg, accent } = getCardPalette(5);

  if (chats.length === 0 && chatOtherCount === 0) {
    return (
      <section
        className={`${bg} rounded-[20px] p-6 border border-border/40 break-inside-avoid`}
      >
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          Top Chats
        </p>
        <p className="text-sm text-muted-foreground">No chats in this period</p>
      </section>
    );
  }

  const totalCount = chats.length + chatOtherCount;
  const maxValue = Math.max(
    1,
    ...chats.map((c) => {
      return metric === "credits" ? c.credits : c.tokens;
    }),
  );
  const valueLabel = metric === "credits" ? "Credits" : "Tokens";

  return (
    <section
      className={`${bg} rounded-[20px] p-6 border border-border/40 break-inside-avoid`}
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Top Chats
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {totalCount === 1 ? "chat thread" : "chat threads"} · {valueLabel}
      </p>
      <ul className="flex flex-col gap-2.5 mt-4">
        {chats.map((row) => {
          const value = metric === "credits" ? row.credits : row.tokens;
          const pct = (value / maxValue) * 100;
          return (
            <li key={row.threadId}>
              <Link
                pathname="/chats/:threadId"
                options={{ pathParams: { threadId: row.threadId } }}
                className="flex items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-colors hover:bg-foreground/5"
              >
                <span className="text-sm font-medium flex-1 truncate">
                  {row.threadTitle ?? "(untitled)"}
                </span>
                <div className="w-20 h-1.5 rounded-full bg-foreground/10 overflow-hidden shrink-0">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: accent }}
                  />
                </div>
                <span className="text-xs tabular-nums opacity-70 shrink-0 w-12 text-right">
                  {formatValue(value)}
                </span>
              </Link>
            </li>
          );
        })}
        {chatOtherCount > 0 && (
          <li className="flex items-center gap-3 -mx-1.5 px-1.5 py-1">
            <span className="text-sm text-muted-foreground flex-1 truncate">
              +{chatOtherCount} more {chatOtherCount === 1 ? "chat" : "chats"}
            </span>
            {metric === "credits" && (
              <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                {formatValue(chatOtherCredits)}
              </span>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}
