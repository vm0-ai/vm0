import { useGet, useSet } from "ccstate-react";
import {
  ChartLine,
  ChartNoAxesColumnIncreasing,
  ChartPie,
  ChartScatter,
  Plus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Card, Dialog, DialogContent, ToggleButton } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { VISUALIZATION_OUTPUTS } from "../../signals/okou-page/composer-visualization.ts";
import { FEATURED_VISUALIZATION_CHARTS } from "./composer-visualization-chart-data.ts";
import { ComposerVisualizationChartLibrary } from "./composer-visualization-chart-library.tsx";

type FeaturedVisualizationChart =
  (typeof FEATURED_VISUALIZATION_CHARTS)[number];

const CHART_ICONS = {
  bar: ChartNoAxesColumnIncreasing,
  line: ChartLine,
  donut: ChartPie,
  scatter: ChartScatter,
} as const;

function VisualizationHeader() {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {copy.description}
        </p>
      </div>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
        {copy.optional}
      </span>
    </div>
  );
}

function VisualizationOutputPicker({
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
  const output = useGet(signals.taskChips.visualization.output$);
  const setOutput = useSet(signals.taskChips.visualization.setOutput$);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{copy.outputFormat}</span>
        <span className="text-xs text-muted-foreground">{copy.chooseOne}</span>
      </div>
      <div
        className="grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-5"
        role="group"
        aria-label={copy.outputFormat}
      >
        {VISUALIZATION_OUTPUTS.map((item) => {
          return (
            <ToggleButton
              key={item}
              selected={output === item}
              layout="tile"
              className="min-h-9 rounded-lg px-2 py-1.5 text-xs font-normal last:col-span-2 sm:last:col-span-1"
              onClick={() => {
                setOutput(item);
              }}
            >
              {copy.outputs[item]}
            </ToggleButton>
          );
        })}
      </div>
    </div>
  );
}

function FeaturedChartButton({
  chart,
  signals,
}: {
  readonly chart: FeaturedVisualizationChart;
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.visualization;
    },
    { returnObjects: true },
  );
  const charts = useGet(signals.taskChips.visualization.charts$);
  const toggleChart = useSet(signals.taskChips.visualization.toggleChart$);
  const Icon = CHART_ICONS[chart];
  return (
    <ToggleButton
      selected={charts.includes(chart)}
      className="h-8 rounded-full px-3 py-0 text-xs font-normal"
      onClick={() => {
        toggleChart(chart);
      }}
    >
      <Icon size={14} aria-hidden />
      {copy.featuredCharts[chart]}
    </ToggleButton>
  );
}

function VisualizationChartPicker({
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
  const setLibraryOpen = useSet(
    signals.taskChips.visualization.setLibraryOpen$,
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{copy.preferredCharts}</span>
        <span className="text-xs text-muted-foreground">{copy.chooseAny}</span>
      </div>
      <div
        className="flex min-w-0 flex-wrap gap-1.5"
        role="group"
        aria-label={copy.preferredCharts}
      >
        {FEATURED_VISUALIZATION_CHARTS.map((chart) => {
          return (
            <FeaturedChartButton key={chart} chart={chart} signals={signals} />
          );
        })}
        <Button
          type="button"
          variant="outline"
          className="h-8 rounded-full px-3 text-xs font-normal text-muted-foreground"
          onClick={() => {
            setLibraryOpen(true);
          }}
        >
          <Plus size={14} aria-hidden />
          {copy.more}
        </Button>
      </div>
    </div>
  );
}

export function ComposerVisualizationOptions({
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
  const libraryOpen = useGet(signals.taskChips.visualization.libraryOpen$);
  const setLibraryOpen = useSet(
    signals.taskChips.visualization.setLibraryOpen$,
  );
  return (
    <>
      <Card
        className="min-w-0 rounded-2xl p-3 sm:p-4"
        role="region"
        aria-label={copy.panelLabel}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <VisualizationHeader />
          <VisualizationOutputPicker signals={signals} />
          <VisualizationChartPicker signals={signals} />
          <p className="text-xs text-muted-foreground">{copy.chartSafety}</p>
        </div>
      </Card>
      <Dialog
        open={libraryOpen}
        onOpenChange={(open) => {
          setLibraryOpen(open);
        }}
      >
        <DialogContent
          smMaxWidth={680}
          height={760}
          closeLabel={copy.close}
          contentClassName="gap-3 p-4 sm:p-6"
        >
          <ComposerVisualizationChartLibrary signals={signals} />
        </DialogContent>
      </Dialog>
    </>
  );
}
