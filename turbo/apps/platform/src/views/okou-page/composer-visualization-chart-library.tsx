import { useGet, useSet } from "ccstate-react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ToggleButton,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { VISUALIZATION_CHART_CATEGORIES } from "../../signals/okou-page/composer-visualization.ts";
import {
  VISUALIZATION_CHART_LIBRARY,
  type VisualizationChartOption,
} from "./composer-visualization-chart-data.ts";

function ChartLibraryCategories({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const category = useGet(signals.taskChips.visualization.chartCategory$);
  const setCategory = useSet(signals.taskChips.visualization.setChartCategory$);
  return (
    <div
      className="flex min-w-0 flex-wrap gap-1.5"
      role="group"
      aria-label={copy.chartCategories}
    >
      {VISUALIZATION_CHART_CATEGORIES.map((item) => {
        return (
          <ToggleButton
            key={item}
            selected={category === item}
            className="h-8 shrink-0 rounded-full px-3 py-0 text-xs font-normal"
            onClick={() => {
              setCategory(item);
            }}
          >
            {copy.categories[item]}
          </ToggleButton>
        );
      })}
    </div>
  );
}

function ChartLibraryChips({
  signals,
  charts,
}: {
  readonly signals: ComposerSignals;
  readonly charts: readonly VisualizationChartOption[];
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const selectedCharts = useGet(signals.taskChips.visualization.charts$);
  const toggleChart = useSet(signals.taskChips.visualization.toggleChart$);
  if (charts.length === 0) {
    return (
      <div className="grid min-h-20 place-items-center rounded-xl border border-dashed text-xs text-muted-foreground">
        {copy.noCharts}
      </div>
    );
  }
  return (
    <div className="flex min-h-20 min-w-0 flex-wrap content-start gap-1.5">
      {charts.map((chart) => {
        return (
          <ToggleButton
            key={chart.id}
            selected={selectedCharts.includes(chart.id)}
            className="min-h-8 rounded-full px-3 py-1 text-xs font-normal"
            onClick={() => {
              toggleChart(chart.id);
            }}
          >
            {copy.charts[chart.id]}
          </ToggleButton>
        );
      })}
    </div>
  );
}

export function ComposerVisualizationChartLibrary({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const selectedCharts = useGet(signals.taskChips.visualization.charts$);
  const category = useGet(signals.taskChips.visualization.chartCategory$);
  const chartSearch = useGet(signals.taskChips.visualization.chartSearch$);
  const search = chartSearch.trim().toLocaleLowerCase();
  const setSearch = useSet(signals.taskChips.visualization.setChartSearch$);
  const setOpen = useSet(signals.taskChips.visualization.setLibraryOpen$);
  const visibleCharts = VISUALIZATION_CHART_LIBRARY.filter((chart) => {
    const matchesCategory = category === "all" || chart.category === category;
    const haystack = `${copy.charts[chart.id]} ${
      copy.categories[chart.category]
    }`.toLocaleLowerCase();
    return matchesCategory && haystack.includes(search);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DialogHeader className="pr-8 text-left">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <DialogTitle className="text-base">{copy.chooseCharts}</DialogTitle>
          <span className="text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.chat.taskChips.visualization.selectedCount;
              },
              { count: selectedCharts.length },
            )}
          </span>
        </div>
        <DialogDescription className="text-xs">
          {copy.libraryHint}
        </DialogDescription>
      </DialogHeader>
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={chartSearch}
          className="h-9 pl-9 text-xs"
          aria-label={copy.searchCharts}
          placeholder={copy.searchCharts}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
          }}
        />
      </div>
      <DialogBody className="flex flex-col gap-3 pr-1">
        <ChartLibraryCategories signals={signals} />
        <ChartLibraryChips signals={signals} charts={visibleCharts} />
      </DialogBody>
      <DialogFooter className="shrink-0 flex-row justify-end border-t pt-3">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setOpen(false);
          }}
        >
          {copy.done}
        </Button>
      </DialogFooter>
    </div>
  );
}
