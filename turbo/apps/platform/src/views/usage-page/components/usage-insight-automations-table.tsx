import { useGet, useSet } from "ccstate-react";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  hoveredAutomationId$,
  setHoveredAutomationId$,
} from "../../../signals/usage-page/usage-insight-signals.ts";
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

function AutomationUsageRow({
  row,
  maxValue,
  accent,
}: {
  row: UsageInsightResponse["automations"][number];
  maxValue: number;
  accent: string;
}) {
  const hoveredId = useGet(hoveredAutomationId$);
  const setHoveredId = useSet(setHoveredAutomationId$);
  const value = row.credits;
  const pct = (value / maxValue) * 100;
  const isActive = hoveredId === null || hoveredId === row.automationId;
  const fullName = row.automationDescription?.trim() || row.automationName;

  return (
    <li>
      <div
        className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-all duration-150 ${
          hoveredId === row.automationId ? "bg-foreground/5" : ""
        } ${isActive ? "opacity-100" : "opacity-30"}`}
        onMouseEnter={() => {
          setHoveredId(row.automationId);
        }}
        onMouseLeave={() => {
          setHoveredId(null);
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm font-medium truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
              {fullName}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="max-w-xs">
            <p className="text-xs whitespace-normal break-words">{fullName}</p>
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
      </div>
    </li>
  );
}

export function UsageInsightAutomationsTable({
  data,
}: {
  data: UsageInsightResponse;
}) {
  const { t } = useTranslation();
  const { automations, automationOtherCount, automationOtherCredits } = data;
  const { accent } = getCardPalette(2);
  const hoveredId = useGet(hoveredAutomationId$);

  if (automations.length === 0 && automationOtherCount === 0) {
    return (
      <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          {t(($) => {
            return $.usage.automations.title;
          })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.usage.automations.empty;
          })}
        </p>
      </section>
    );
  }

  const totalCount = automations.length + automationOtherCount;
  const totalCredits = automations.reduce((s, r) => {
    return s + r.credits;
  }, automationOtherCredits);
  const maxValue = Math.max(
    1,
    ...automations.map((s) => {
      return s.credits;
    }),
  );
  const automationCount = t(
    ($) => {
      return $.usage.units.automation;
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
          return $.usage.automations.title;
        })}
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {t(
          ($) => {
            return $.usage.automations.summary;
          },
          {
            count: totalCount,
            automations: automationCount,
            credits: creditCount,
          },
        )}
      </p>
      <TooltipProvider delayDuration={300}>
        <ul className="flex flex-col gap-2.5 mt-4">
          {automations.map((row) => {
            return (
              <AutomationUsageRow
                key={row.automationId}
                row={row}
                maxValue={maxValue}
                accent={accent}
              />
            );
          })}
          {automationOtherCount > 0 && (
            <li
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 transition-opacity duration-150 ${
                hoveredId === null ? "opacity-100" : "opacity-30"
              }`}
            >
              <span className="text-sm text-muted-foreground truncate col-span-2">
                {t(
                  ($) => {
                    return $.usage.automations.more;
                  },
                  {
                    count: automationOtherCount,
                    value: formatLocalizedNumber(automationOtherCount),
                  },
                )}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">
                {formatCompactNumber(automationOtherCredits)}
              </span>
            </li>
          )}
        </ul>
      </TooltipProvider>
    </section>
  );
}
