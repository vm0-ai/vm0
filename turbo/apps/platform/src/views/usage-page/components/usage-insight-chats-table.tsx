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
import { useTranslation } from "react-i18next";
import {
  formatCompactNumber,
  formatLocalizedNumber,
} from "../../../i18n/format.ts";

function ChatUsageRow({
  row,
  maxValue,
  accent,
}: {
  row: UsageInsightResponse["chats"][number];
  maxValue: number;
  accent: string;
}) {
  const { t } = useTranslation();
  const hoveredId = useGet(hoveredChatId$);
  const setHoveredId = useSet(setHoveredChatId$);
  const value = row.credits;
  const pct = (value / maxValue) * 100;
  const isActive = hoveredId === null || hoveredId === row.threadId;
  const fullTitle =
    row.threadTitle ??
    t(($) => {
      return $.usage.chats.untitled;
    });

  return (
    <li>
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
          <TooltipContent side="top" sideOffset={4} className="max-w-xs">
            <p className="text-xs whitespace-normal break-words">{fullTitle}</p>
            <p className="text-[11px] mt-1.5 pt-1.5 border-t border-white/15 opacity-80">
              {t(($) => {
                return $.usage.chats.clickToOpen;
              })}
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
          {formatCompactNumber(value)}
        </span>
      </Link>
    </li>
  );
}

export function UsageInsightChatsTable({
  data,
}: {
  data: UsageInsightResponse;
}) {
  const { t } = useTranslation();
  const { chats, chatOtherCount, chatOtherCredits } = data;
  const { accent } = getCardPalette(5);
  const hoveredId = useGet(hoveredChatId$);

  if (chats.length === 0 && chatOtherCount === 0) {
    return (
      <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          {t(($) => {
            return $.usage.chats.title;
          })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.usage.chats.empty;
          })}
        </p>
      </section>
    );
  }

  const totalCount = chats.length + chatOtherCount;
  const totalCredits = chats.reduce((s, r) => {
    return s + r.credits;
  }, chatOtherCredits);
  const maxValue = Math.max(
    1,
    ...chats.map((c) => {
      return c.credits;
    }),
  );
  const chatCount = t(
    ($) => {
      return $.usage.units.chat;
    },
    {
      count: totalCount,
      value: formatLocalizedNumber(totalCount),
    },
  );
  const creditCount = t(
    ($) => {
      return $.usage.units.credit;
    },
    {
      count: totalCredits,
      value: formatCompactNumber(totalCredits),
    },
  );

  return (
    <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        {t(($) => {
          return $.usage.chats.title;
        })}
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {t(
          ($) => {
            return $.usage.chats.summary;
          },
          {
            count: totalCount,
            chats: chatCount,
            credits: creditCount,
          },
        )}
      </p>
      <TooltipProvider delayDuration={300}>
        <ul className="flex flex-col gap-2.5 mt-4">
          {chats.map((row) => {
            return (
              <ChatUsageRow
                key={row.threadId}
                row={row}
                maxValue={maxValue}
                accent={accent}
              />
            );
          })}
          {chatOtherCount > 0 && (
            <li
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 transition-opacity duration-150 ${
                hoveredId === null ? "opacity-100" : "opacity-30"
              }`}
            >
              <span className="text-sm text-muted-foreground truncate col-span-2">
                {t(
                  ($) => {
                    return $.usage.chats.more;
                  },
                  {
                    count: chatOtherCount,
                    value: formatLocalizedNumber(chatOtherCount),
                  },
                )}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">
                {formatCompactNumber(chatOtherCredits)}
              </span>
            </li>
          )}
        </ul>
      </TooltipProvider>
    </section>
  );
}
