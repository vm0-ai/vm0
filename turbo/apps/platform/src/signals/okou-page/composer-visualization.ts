import { command, computed, state } from "ccstate";

export const VISUALIZATION_OUTPUTS = [
  "single-chart",
  "presentation",
  "website",
  "spreadsheet",
  "report",
] as const;

export const VISUALIZATION_CHART_CATEGORIES = [
  "all",
  "comparison",
  "trend",
  "composition",
  "distribution",
  "relationship",
  "map",
  "metric",
  "more",
] as const;

export const VISUALIZATION_CHARTS = [
  "bar",
  "horizontal-bar",
  "grouped-bar",
  "stacked-bar",
  "percent-stacked-bar",
  "waterfall",
  "bullet",
  "pictorial-bar",
  "polar-bar",
  "lollipop",
  "diverging-bar",
  "bar-race",
  "line",
  "smooth-line",
  "step-line",
  "area",
  "stacked-area",
  "theme-river",
  "candlestick",
  "threshold-line",
  "small-multiples",
  "animated-timeline",
  "pie",
  "donut",
  "rose",
  "nested-donut",
  "funnel",
  "comparison-funnel",
  "treemap",
  "sunburst",
  "liquid-fill",
  "scatter",
  "bubble",
  "ripple-scatter",
  "heatmap",
  "calendar-heatmap",
  "box-plot",
  "histogram",
  "scatter-trendline",
  "strip-plot",
  "radar",
  "parallel-coordinates",
  "sankey",
  "network",
  "chord",
  "flowchart",
  "tree",
  "radial-tree",
  "choropleth-map",
  "geo-scatter",
  "route-map",
  "gauge",
  "progress-ring",
  "grade-gauge",
  "kpi-card",
  "kpi-sparkline",
  "word-cloud",
  "gantt",
  "3d-bar",
  "3d-scatter",
  "3d-surface",
  "3d-line",
] as const;

export type VisualizationOutput = (typeof VISUALIZATION_OUTPUTS)[number];
export type VisualizationChart = (typeof VISUALIZATION_CHARTS)[number];
export type VisualizationChartCategory =
  (typeof VISUALIZATION_CHART_CATEGORIES)[number];

export interface VisualizationPreferences {
  readonly output: VisualizationOutput | null;
  readonly charts: readonly VisualizationChart[];
}

export function createComposerVisualizationSignals() {
  const output$ = state<VisualizationOutput | null>(null);
  const charts$ = state<readonly VisualizationChart[]>([]);
  const libraryOpen$ = state(false);
  const chartCategory$ = state<VisualizationChartCategory>("all");
  const chartSearch$ = state("");
  const preferences$ = computed((get): VisualizationPreferences => {
    return {
      output: get(output$),
      charts: get(charts$),
    };
  });
  const setOutput$ = command(({ get, set }, output: VisualizationOutput) => {
    set(output$, get(output$) === output ? null : output);
  });
  const toggleChart$ = command(({ get, set }, chart: VisualizationChart) => {
    const charts = get(charts$);
    set(
      charts$,
      charts.includes(chart)
        ? charts.filter((item) => {
            return item !== chart;
          })
        : [...charts, chart],
    );
  });
  const setLibraryOpen$ = command(({ set }, open: boolean) => {
    set(libraryOpen$, open);
  });
  const setChartCategory$ = command(
    ({ set }, category: VisualizationChartCategory) => {
      set(chartCategory$, category);
    },
  );
  const setChartSearch$ = command(({ set }, search: string) => {
    set(chartSearch$, search);
  });
  return {
    output$,
    charts$,
    libraryOpen$,
    chartCategory$,
    chartSearch$,
    preferences$,
    setOutput$,
    toggleChart$,
    setLibraryOpen$,
    setChartCategory$,
    setChartSearch$,
  };
}
