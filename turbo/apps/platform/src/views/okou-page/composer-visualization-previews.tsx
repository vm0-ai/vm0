import type { ComponentType } from "react";
import type {
  VisualizationChart,
  VisualizationOutput,
} from "../../signals/okou-page/composer-visualization.ts";

const GRID_LINES = [18, 34, 50, 66] as const;

function ChartGrid() {
  return (
    <>
      {GRID_LINES.map((y) => {
        return (
          <line
            key={y}
            x1="10"
            x2="110"
            y1={y}
            y2={y}
            className="stroke-gray-200"
            strokeWidth="1"
          />
        );
      })}
      <line
        x1="10"
        x2="110"
        y1="78"
        y2="78"
        className="stroke-gray-300"
        strokeWidth="1"
      />
    </>
  );
}

function SingleChartOutputArtwork() {
  return (
    <>
      <rect x="20" y="7" width="100" height="62" rx="5" fill="white" />
      <path
        d="M31 54 43 45 55 49 67 35 79 40 91 22 108 29"
        fill="none"
        className="stroke-gray-400"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="30" x2="110" y1="59" y2="59" className="stroke-gray-200" />
    </>
  );
}

function PresentationOutputArtwork() {
  return (
    <>
      <rect x="13" y="7" width="114" height="62" rx="5" fill="white" />
      {[15, 33, 51].map((y) => {
        return (
          <rect
            key={y}
            x="21"
            y={y}
            width="19"
            height={y === 51 ? 10 : 13}
            rx="2"
            className="fill-gray-100"
          />
        );
      })}
      <rect
        x="49"
        y="15"
        width="68"
        height="7"
        rx="2"
        className="fill-gray-200"
      />
      <rect
        x="49"
        y="28"
        width="11"
        height="28"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="65"
        y="37"
        width="11"
        height="19"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="81"
        y="23"
        width="11"
        height="33"
        rx="2"
        className="fill-gray-400"
      />
      <rect
        x="97"
        y="32"
        width="11"
        height="24"
        rx="2"
        className="fill-gray-300"
      />
    </>
  );
}

function WebsiteOutputArtwork() {
  return (
    <>
      <rect x="13" y="7" width="114" height="62" rx="5" fill="white" />
      {[22, 29, 36].map((cx) => {
        return (
          <circle key={cx} cx={cx} cy="15" r="2" className="fill-gray-300" />
        );
      })}
      <rect
        x="22"
        y="26"
        width="47"
        height="5"
        rx="2"
        className="fill-gray-200"
      />
      <rect
        x="22"
        y="36"
        width="58"
        height="4"
        rx="2"
        className="fill-gray-100"
      />
      <rect
        x="22"
        y="45"
        width="28"
        height="14"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="84"
        y="48"
        width="7"
        height="11"
        rx="1"
        className="fill-gray-300"
      />
      <rect
        x="95"
        y="38"
        width="7"
        height="21"
        rx="1"
        className="fill-gray-400"
      />
      <rect
        x="106"
        y="30"
        width="7"
        height="29"
        rx="1"
        className="fill-gray-300"
      />
    </>
  );
}

function SpreadsheetOutputArtwork() {
  return (
    <>
      <rect x="13" y="7" width="114" height="62" rx="5" fill="white" />
      {[22, 32, 42, 52].map((y) => {
        return (
          <line
            key={y}
            x1="20"
            x2="120"
            y1={y}
            y2={y}
            className="stroke-gray-200"
          />
        );
      })}
      {[42, 65, 88].map((x) => {
        return (
          <line
            key={x}
            x1={x}
            x2={x}
            y1="14"
            y2="60"
            className="stroke-gray-200"
          />
        );
      })}
      <rect
        x="68"
        y="34"
        width="17"
        height="6"
        rx="1"
        className="fill-gray-300"
      />
      <rect
        x="91"
        y="44"
        width="26"
        height="6"
        rx="1"
        className="fill-gray-400"
      />
    </>
  );
}

function ReportOutputArtwork() {
  return (
    <>
      <rect
        x="41"
        y="5"
        width="69"
        height="60"
        rx="5"
        className="fill-gray-100"
      />
      <rect x="27" y="12" width="72" height="56" rx="5" fill="white" />
      <rect
        x="37"
        y="22"
        width="39"
        height="5"
        rx="2"
        className="fill-gray-200"
      />
      <rect
        x="37"
        y="32"
        width="52"
        height="4"
        rx="2"
        className="fill-gray-100"
      />
      <rect
        x="37"
        y="41"
        width="8"
        height="17"
        rx="1"
        className="fill-gray-300"
      />
      <rect
        x="50"
        y="48"
        width="8"
        height="10"
        rx="1"
        className="fill-gray-300"
      />
      <rect
        x="63"
        y="37"
        width="8"
        height="21"
        rx="1"
        className="fill-gray-400"
      />
      <circle
        cx="82"
        cy="50"
        r="9"
        fill="none"
        className="stroke-gray-300"
        strokeWidth="5"
      />
    </>
  );
}

const OUTPUT_ARTWORKS = {
  "single-chart": SingleChartOutputArtwork,
  presentation: PresentationOutputArtwork,
  website: WebsiteOutputArtwork,
  spreadsheet: SpreadsheetOutputArtwork,
  report: ReportOutputArtwork,
} satisfies Record<VisualizationOutput, ComponentType>;

export function VisualizationOutputPreview({
  output,
}: {
  readonly output: VisualizationOutput;
}) {
  const Artwork = OUTPUT_ARTWORKS[output];
  return (
    <svg
      viewBox="0 0 140 72"
      className="h-[68px] w-full"
      aria-hidden
      focusable="false"
    >
      <Artwork />
    </svg>
  );
}

function BarChartArtwork() {
  return (
    <>
      {[32, 19, 43, 27, 52, 36].map((height, index) => {
        return (
          <rect
            key={height}
            x={17 + index * 15}
            y={78 - height}
            width="8"
            height={height}
            rx="1.5"
            className={index === 4 ? "fill-gray-500" : "fill-gray-300"}
          />
        );
      })}
    </>
  );
}

function LineChartArtwork() {
  return (
    <path
      d="M12 29 27 35 42 62 57 43 72 39 87 52 108 48"
      fill="none"
      className="stroke-gray-500"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function PieChartArtwork() {
  return (
    <>
      <circle cx="60" cy="47" r="27" className="fill-gray-100" />
      <path d="M60 47V20A27 27 0 0 1 84 60Z" className="fill-gray-400" />
      <path d="M60 47 84 60A27 27 0 0 1 43 68Z" className="fill-gray-300" />
    </>
  );
}

function ScatterChartArtwork() {
  return (
    <>
      {[
        [20, 66],
        [31, 58],
        [38, 49],
        [48, 55],
        [57, 43],
        [66, 35],
        [76, 46],
        [84, 28],
        [93, 37],
        [103, 21],
        [106, 54],
      ].map(([cx, cy], index) => {
        return (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={index % 3 === 0 ? 4 : 3}
            className={index % 4 === 0 ? "fill-gray-500" : "fill-gray-300"}
          />
        );
      })}
    </>
  );
}

function AreaChartArtwork() {
  return (
    <>
      <path
        d="M10 69 25 61 40 65 55 46 70 51 85 30 100 38 110 27V78H10Z"
        className="fill-gray-200"
      />
      <path
        d="M10 69 25 61 40 65 55 46 70 51 85 30 100 38 110 27"
        fill="none"
        className="stroke-gray-500"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </>
  );
}

function StackedBarChartArtwork() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((position) => {
        const first = 18 + position * 2;
        const second = 13 + (position % 2) * 5;
        const third = 10 + ((position + 1) % 3) * 3;
        const x = 19 + position * 18;
        return (
          <g key={x}>
            <rect
              x={x}
              y={78 - first}
              width="10"
              height={first}
              rx="1"
              className="fill-gray-300"
            />
            <rect
              x={x}
              y={78 - first - second}
              width="10"
              height={second}
              rx="1"
              className="fill-gray-400"
            />
            <rect
              x={x}
              y={78 - first - second - third}
              width="10"
              height={third}
              rx="1"
              className="fill-gray-200"
            />
          </g>
        );
      })}
    </>
  );
}

function HeatmapChartArtwork() {
  const colors = [
    "fill-gray-100",
    "fill-gray-200",
    "fill-gray-300",
    "fill-gray-400",
    "fill-gray-500",
  ];
  return (
    <>
      {[0, 1, 2, 3, 4].flatMap((row) => {
        return [0, 1, 2, 3, 4, 5, 6].map((column) => {
          const level = (row * 3 + column * 2) % colors.length;
          return (
            <rect
              key={`${row}-${column}`}
              x={19 + column * 13}
              y={18 + row * 11}
              width="10"
              height="8"
              rx="1"
              className={colors[level]}
            />
          );
        });
      })}
    </>
  );
}

function BubbleChartArtwork() {
  return (
    <>
      {[
        [25, 61, 8],
        [40, 45, 5],
        [54, 57, 11],
        [65, 31, 7],
        [78, 50, 5],
        [91, 29, 13],
        [102, 58, 7],
      ].map(([cx, cy, radius], index) => {
        return (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={radius}
            className={index % 3 === 0 ? "fill-gray-500" : "fill-gray-300"}
            fillOpacity={index % 3 === 0 ? 0.9 : 0.65}
          />
        );
      })}
    </>
  );
}

function RadarChartArtwork() {
  return (
    <>
      <polygon
        points="60,14 91,33 84,68 60,80 34,66 29,32"
        fill="none"
        className="stroke-gray-200"
      />
      <polygon
        points="60,25 80,37 76,61 60,69 43,60 38,37"
        fill="none"
        className="stroke-gray-200"
      />
      <polygon
        points="60,20 85,39 73,66 55,60 38,57 44,35"
        className="fill-gray-200 stroke-gray-500"
        fillOpacity="0.7"
        strokeWidth="2"
      />
    </>
  );
}

function SankeyChartArtwork() {
  return (
    <>
      <rect
        x="13"
        y="21"
        width="8"
        height="48"
        rx="2"
        className="fill-gray-400"
      />
      <rect
        x="55"
        y="29"
        width="8"
        height="39"
        rx="2"
        className="fill-gray-500"
      />
      <rect
        x="99"
        y="17"
        width="8"
        height="23"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="99"
        y="52"
        width="8"
        height="21"
        rx="2"
        className="fill-gray-400"
      />
      <path
        d="M21 29C36 29 40 37 55 37"
        fill="none"
        className="stroke-gray-300"
        strokeWidth="10"
        strokeOpacity="0.65"
      />
      <path
        d="M21 56C36 56 40 59 55 59"
        fill="none"
        className="stroke-gray-400"
        strokeWidth="13"
        strokeOpacity="0.65"
      />
      <path
        d="M63 38C78 38 84 27 99 27"
        fill="none"
        className="stroke-gray-300"
        strokeWidth="11"
        strokeOpacity="0.6"
      />
      <path
        d="M63 58C78 58 84 62 99 62"
        fill="none"
        className="stroke-gray-400"
        strokeWidth="11"
        strokeOpacity="0.6"
      />
    </>
  );
}

function GanttChartArtwork() {
  return (
    <>
      <rect
        x="20"
        y="19"
        width="34"
        height="7"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="44"
        y="32"
        width="43"
        height="7"
        rx="2"
        className="fill-gray-400"
      />
      <rect
        x="32"
        y="45"
        width="29"
        height="7"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="72"
        y="58"
        width="31"
        height="7"
        rx="2"
        className="fill-gray-500"
      />
    </>
  );
}

function BarRaceChartArtwork() {
  return (
    <>
      <rect
        x="18"
        y="20"
        width="71"
        height="8"
        rx="2"
        className="fill-gray-500"
      />
      <rect
        x="18"
        y="34"
        width="48"
        height="8"
        rx="2"
        className="fill-gray-400"
      />
      <rect
        x="18"
        y="48"
        width="84"
        height="8"
        rx="2"
        className="fill-gray-300"
      />
      <rect
        x="18"
        y="62"
        width="58"
        height="8"
        rx="2"
        className="fill-gray-200"
      />
      <path d="m101 67 9 5-9 5Z" className="fill-gray-500" />
    </>
  );
}

function CandlestickChartArtwork() {
  return (
    <>
      {[
        [24, 29, 18, 43],
        [40, 42, 30, 60],
        [56, 33, 21, 51],
        [72, 47, 36, 68],
        [88, 25, 16, 45],
        [104, 38, 28, 59],
      ].map(([x, top, wickTop, bottom], index) => {
        return (
          <g key={x}>
            <line
              x1={x}
              x2={x}
              y1={wickTop}
              y2={bottom + 7}
              className="stroke-gray-500"
              strokeWidth="1.5"
            />
            <rect
              x={x - 4}
              y={top}
              width="8"
              height={bottom - top}
              rx="1"
              className={
                index % 2 === 0
                  ? "fill-gray-500"
                  : "fill-gray-200 stroke-gray-400"
              }
            />
          </g>
        );
      })}
    </>
  );
}

function FunnelChartArtwork() {
  return (
    <>
      <path d="M16 18H104L93 32H27Z" className="fill-gray-500" />
      <path d="M29 37H91L82 50H38Z" className="fill-gray-400" />
      <path d="M40 55H80L72 68H48Z" className="fill-gray-300" />
    </>
  );
}

function NestedDonutChartArtwork() {
  return (
    <>
      <circle
        cx="60"
        cy="47"
        r="31"
        fill="none"
        className="stroke-gray-100"
        strokeWidth="8"
      />
      <circle
        cx="60"
        cy="47"
        r="31"
        fill="none"
        className="stroke-gray-400"
        strokeWidth="8"
        strokeDasharray="115 80"
        transform="rotate(-90 60 47)"
      />
      <circle
        cx="60"
        cy="47"
        r="20"
        fill="none"
        className="stroke-gray-200"
        strokeWidth="7"
      />
      <circle
        cx="60"
        cy="47"
        r="20"
        fill="none"
        className="stroke-gray-500"
        strokeWidth="7"
        strokeDasharray="48 78"
        transform="rotate(25 60 47)"
      />
    </>
  );
}

function RouteMapChartArtwork() {
  return (
    <>
      <path
        d="M18 59 28 27 47 19 58 35 76 23 102 29 107 59 88 70 65 61 43 72Z"
        className="fill-gray-100 stroke-gray-300"
        strokeWidth="1.5"
      />
      <path
        d="M28 58C45 27 69 69 96 32"
        fill="none"
        className="stroke-gray-500"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
      <circle cx="28" cy="58" r="4" className="fill-gray-500" />
      <circle cx="96" cy="32" r="4" className="fill-gray-500" />
    </>
  );
}

function ChoroplethMapChartArtwork() {
  return (
    <>
      <path
        d="M15 49 23 24 42 18 53 29 68 21 81 29 104 26 109 48 97 67 76 65 61 76 42 66 25 69Z"
        className="fill-gray-100 stroke-gray-300"
        strokeWidth="1.5"
      />
      <path
        d="m23 24 19 18 11-13 8 47M42 42l34 23m-8-44 8 44m5-36 16 38M15 49l27-7 19 34m43-50L76 65"
        fill="none"
        className="stroke-gray-300"
      />
      <path
        d="m42 42 11-13 15-8 8 44Z"
        className="fill-gray-400"
        fillOpacity="0.8"
      />
      <path d="m76 65 21 2 12-19-5-22Z" className="fill-gray-300" />
    </>
  );
}

function WordCloudChartArtwork() {
  return (
    <>
      <rect
        x="34"
        y="37"
        width="52"
        height="10"
        rx="5"
        className="fill-gray-500"
      />
      <rect
        x="17"
        y="25"
        width="31"
        height="6"
        rx="3"
        className="fill-gray-300"
      />
      <rect
        x="62"
        y="23"
        width="41"
        height="7"
        rx="3.5"
        className="fill-gray-400"
      />
      <rect
        x="22"
        y="53"
        width="19"
        height="7"
        rx="3.5"
        className="fill-gray-400"
      />
      <rect
        x="50"
        y="54"
        width="53"
        height="6"
        rx="3"
        className="fill-gray-300"
      />
      <rect
        x="40"
        y="66"
        width="37"
        height="5"
        rx="2.5"
        className="fill-gray-300"
      />
    </>
  );
}

const CHART_ARTWORKS = {
  bar: BarChartArtwork,
  line: LineChartArtwork,
  pie: PieChartArtwork,
  scatter: ScatterChartArtwork,
  area: AreaChartArtwork,
  "stacked-bar": StackedBarChartArtwork,
  heatmap: HeatmapChartArtwork,
  bubble: BubbleChartArtwork,
  radar: RadarChartArtwork,
  sankey: SankeyChartArtwork,
  gantt: GanttChartArtwork,
  "bar-race": BarRaceChartArtwork,
  candlestick: CandlestickChartArtwork,
  funnel: FunnelChartArtwork,
  "nested-donut": NestedDonutChartArtwork,
  "route-map": RouteMapChartArtwork,
  "choropleth-map": ChoroplethMapChartArtwork,
  "word-cloud": WordCloudChartArtwork,
} satisfies Record<VisualizationChart, ComponentType>;

const GRID_CHARTS = [
  "bar",
  "line",
  "scatter",
  "area",
  "stacked-bar",
  "heatmap",
  "bubble",
  "gantt",
  "candlestick",
] as const satisfies readonly VisualizationChart[];

export function VisualizationChartPreview({
  chart,
}: {
  readonly chart: VisualizationChart;
}) {
  const Artwork = CHART_ARTWORKS[chart];
  return (
    <svg
      viewBox="0 0 120 88"
      className="h-full w-full"
      aria-hidden
      focusable="false"
    >
      {GRID_CHARTS.some((item) => {
        return item === chart;
      }) ? (
        <ChartGrid />
      ) : null}
      <Artwork />
    </svg>
  );
}
