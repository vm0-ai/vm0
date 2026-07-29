import { useGet, useSet } from "ccstate-react";
import {
  range$,
  setRange$,
  type InsightRange,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { useTranslation } from "react-i18next";

export function UsageInsightSelectors() {
  const { t } = useTranslation();
  const range = useGet(range$);
  const setRange = useSet(setRange$);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={range}
        onValueChange={(v) => {
          setRange(v as InsightRange);
        }}
      >
        <SelectTrigger
          aria-label={t(($) => {
            return $.usage.range.ariaLabel;
          })}
          className="h-8 w-[140px] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="today">
            {t(($) => {
              return $.usage.range.today;
            })}
          </SelectItem>
          <SelectItem value="yesterday">
            {t(($) => {
              return $.usage.range.yesterday;
            })}
          </SelectItem>
          <SelectItem value="7d">
            {t(($) => {
              return $.usage.range.last7Days;
            })}
          </SelectItem>
          <SelectItem value="28d">
            {t(($) => {
              return $.usage.range.last28Days;
            })}
          </SelectItem>
          <SelectItem value="30d">
            {t(($) => {
              return $.usage.range.last30Days;
            })}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
