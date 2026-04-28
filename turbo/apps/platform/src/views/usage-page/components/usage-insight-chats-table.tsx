import { useGet, useSet } from "ccstate-react";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  hoveredChatId$,
  setHoveredChatId$,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";
import { getCardPalette } from "../../../lib/card-palette.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";

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
}: {
  data: UsageInsightResponse;
}) {
  const { chats, chatOtherCount, chatOtherCredits } = data;
  const { accent } = getCardPalette(5);
  const hoveredId = useGet(hoveredChatId$);
  const setHoveredId = useSet(setHoveredChatId$);

  if (chats.length === 0 && chatOtherCount === 0) {
    return (
      <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          Chats
        </p>
        <p className="text-sm text-muted-foreground">No chats in this period</p>
      </section>
    );
  }

  const totalCount = chats.length + chatOtherCount;
  const maxValue = Math.max(
    1,
    ...chats.map((c) => {
      return c.credits;
    }),
  );

  return (
    <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Chats
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <TooltipProvider delayDuration={300}>
        <ul className="flex flex-col gap-2.5 mt-4">
          {chats.map((row) => {
            const value = row.credits;
            const pct = (value / maxValue) * 100;
            const isActive = hoveredId === null || hoveredId === row.threadId;
            const fullTitle = row.threadTitle ?? "(untitled)";
            return (
              <li key={row.threadId}>
                <Link
                  pathname="/chats/:threadId"
                  options={{ pathParams: { threadId: row.threadId } }}
                  className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-all duration-150 ${
                    hoveredId === row.threadId ? "bg-foreground/5" : ""
                  } ${isActive ? "opacity-100" : "opacity-30"}`}
                  onMouseEnter={() => {
                    setHoveredId(row.threadId);
                  }}
                  onMouseLeave={() => {
                    setHoveredId(null);
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-sm font-medium truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
                        {fullTitle}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      <p className="text-xs">{fullTitle}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Click to open chat
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: accent }}
                    />
                  </div>
                  <span className="text-xs tabular-nums opacity-70 text-right">
                    {formatValue(value)}
                  </span>
                </Link>
              </li>
            );
          })}
          {chatOtherCount > 0 && (
            <li
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 transition-opacity duration-150 ${
                hoveredId === null ? "opacity-100" : "opacity-30"
              }`}
            >
              <span className="text-sm text-muted-foreground truncate col-span-2">
                +{chatOtherCount} more {chatOtherCount === 1 ? "chat" : "chats"}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">
                {formatValue(chatOtherCredits)}
              </span>
            </li>
          )}
        </ul>
      </TooltipProvider>
    </section>
  );
}
