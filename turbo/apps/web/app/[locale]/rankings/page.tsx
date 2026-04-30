import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import {
  VM0_MODEL_ALIAS_TO_MODEL,
  normalizeVm0ModelId,
} from "@vm0/api-contracts/contracts/model-providers";

import { type Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { initServices } from "../../../src/lib/init-services";
import { MODELS, vendorIconPath, type ModelEntry } from "../models/data";

const BASE_URL = "https://www.vm0.ai";
const HOUR_MS = 60 * 60_000;
const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"];

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

interface RankingRow {
  readonly rank: number;
  readonly model: string;
  readonly name: string;
  readonly vendor: string;
  readonly iconPath: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly totalTokens: number;
  readonly previousTotalTokens: number;
  readonly share: number;
}

interface RawRankingRow {
  readonly model: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_tokens: unknown;
  readonly total_tokens: unknown;
  readonly previous_total_tokens: unknown;
}

export const dynamic = "force-dynamic";

const MODELS_BY_ID = new Map(
  MODELS.flatMap((model) => {
    return [
      [model.modelId.toLowerCase(), model],
      [model.slug.toLowerCase(), model],
    ] as const;
  }),
);

function getModelAliasEntries() {
  return Object.entries(VM0_MODEL_ALIAS_TO_MODEL);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const title = "AI Model Rankings";
  const description =
    "Hourly VM0 model usage rankings across today, this week, and this month.";
  const url = `${BASE_URL}/${locale}/rankings`;

  return {
    title,
    description,
    alternates: buildLocaleAlternates("/rankings", locale as Locale),
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

function parsePeriod(value: string | string[] | undefined): PeriodKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return PERIODS.some((period) => {
    return period.key === raw;
  })
    ? (raw as PeriodKey)
    : "week";
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  const dayOfWeek = day.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return new Date(day.getTime() - daysSinceMonday * 24 * HOUR_MS);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function currentUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    ),
  );
}

function currentWindow(
  period: PeriodKey,
  now: Date,
): { start: Date; end: Date } {
  const end = currentUtcHour(now);
  if (period === "today") {
    return { start: startOfUtcDay(now), end };
  }
  if (period === "month") {
    return { start: startOfUtcMonth(now), end };
  }
  return { start: startOfUtcWeek(now), end };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000_000) {
    return `${(value / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

function formatShare(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

function formatChange(
  current: number,
  previous: number,
): {
  label: string;
  tone: "up" | "down" | "flat" | "new";
} {
  if (previous === 0) {
    return current > 0
      ? { label: "new", tone: "new" }
      : { label: "0%", tone: "flat" };
  }

  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) {
    return { label: "0%", tone: "flat" };
  }

  const rounded = Math.round(change);
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}%`,
    tone: rounded > 0 ? "up" : "down",
  };
}

function resolveModel(modelId: string): ModelEntry | undefined {
  const normalizedModelId = normalizeVm0ModelId(modelId);
  const direct = MODELS_BY_ID.get(normalizedModelId.toLowerCase());
  if (direct) return direct;

  const [, suffix] = normalizedModelId.split("/");
  if (!suffix) return undefined;

  return MODELS_BY_ID.get(suffix.toLowerCase());
}

function modelStatModelExpression() {
  const modelColumn = sql.raw('"model_stat"."model"');
  return sql<string>`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${modelColumn} = ${alias} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${modelColumn} END`;
}

async function getRankings(period: PeriodKey): Promise<{
  rows: RankingRow[];
  totalTokens: number;
  windowStart: Date;
  windowEnd: Date;
}> {
  initServices();

  const window = currentWindow(period, new Date());
  const duration = Math.max(window.end.getTime() - window.start.getTime(), 0);
  const previousEnd = window.start;
  const previousStart = new Date(previousEnd.getTime() - duration);
  const modelExpr = modelStatModelExpression();

  const result = await globalThis.services.db.execute(sql`
    WITH current_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.inputTokens}), 0)::bigint AS input_tokens,
        COALESCE(SUM(${modelStat.outputTokens}), 0)::bigint AS output_tokens,
        COALESCE(SUM(${modelStat.cacheReadInputTokens} + ${modelStat.cacheCreationInputTokens}), 0)::bigint AS cache_tokens,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${window.start}
        AND ${modelStat.hourStart} < ${window.end}
      GROUP BY 1
    ),
    previous_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS previous_total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${previousStart}
        AND ${modelStat.hourStart} < ${previousEnd}
      GROUP BY 1
    )
    SELECT
      current_period.model,
      current_period.input_tokens,
      current_period.output_tokens,
      current_period.cache_tokens,
      current_period.total_tokens,
      COALESCE(previous_period.previous_total_tokens, 0)::bigint AS previous_total_tokens
    FROM current_period
    LEFT JOIN previous_period ON previous_period.model = current_period.model
    WHERE current_period.total_tokens > 0
    ORDER BY current_period.total_tokens DESC
    LIMIT 50
  `);

  const rawRows = result.rows as unknown as RawRankingRow[];
  const knownRows: {
    readonly row: RawRankingRow;
    readonly model: string;
    readonly modelEntry: ModelEntry;
    readonly totalTokens: number;
  }[] = [];

  for (const row of rawRows) {
    const model = String(row.model);
    const modelEntry = resolveModel(model);
    if (!modelEntry) continue;
    knownRows.push({
      row,
      model,
      modelEntry,
      totalTokens: toNumber(row.total_tokens),
    });
  }

  const totalTokens = knownRows.reduce((sum, row) => {
    return sum + row.totalTokens;
  }, 0);

  return {
    totalTokens,
    windowStart: window.start,
    windowEnd: window.end,
    rows: knownRows.map((item, index) => {
      return {
        rank: index + 1,
        model: item.model,
        name: item.modelEntry.name,
        vendor: item.modelEntry.vendor,
        iconPath: vendorIconPath(item.modelEntry.vendor),
        inputTokens: toNumber(item.row.input_tokens),
        outputTokens: toNumber(item.row.output_tokens),
        cacheTokens: toNumber(item.row.cache_tokens),
        totalTokens: item.totalTokens,
        previousTotalTokens: toNumber(item.row.previous_total_tokens),
        share: totalTokens > 0 ? (item.totalTokens / totalTokens) * 100 : 0,
      };
    }),
  };
}

function formatWindow(start: Date, end: Date): string {
  if (end <= start) {
    return "Waiting for the first completed UTC hour";
  }
  const fmt = (date: Date) => {
    return date.toISOString().slice(0, 10);
  };
  if (fmt(start) === fmt(end)) {
    return `${fmt(start)} UTC`;
  }
  return `${fmt(start)} → ${fmt(end)} UTC`;
}

function PeriodTabs({ active, locale }: { active: PeriodKey; locale: string }) {
  return (
    <div className="uc-filter-row" role="tablist" aria-label="Ranking period">
      {PERIODS.map((period) => {
        const isActive = active === period.key;
        return (
          <a
            key={period.key}
            href={`/${locale}/rankings?view=${period.key}`}
            role="tab"
            aria-selected={isActive}
            className={`uc-pill${isActive ? " uc-pill--active" : ""}`}
            style={{ textDecoration: "none" }}
          >
            {period.label}
          </a>
        );
      })}
    </div>
  );
}

function ChangeBadge({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  const change = formatChange(current, previous);
  const color =
    change.tone === "up" || change.tone === "new"
      ? "#3F7B5A"
      : change.tone === "down"
        ? "#B45848"
        : "var(--text-muted)";

  return (
    <span
      style={{ color, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
    >
      {change.label}
    </span>
  );
}

function StatBlock({
  label,
  value,
  variant = "lg",
}: {
  label: string;
  value: string;
  variant?: "lg" | "sm";
}) {
  const valueStyle: React.CSSProperties =
    variant === "lg"
      ? {
          fontSize: "28px",
          fontWeight: 300,
          letterSpacing: "-0.5px",
          lineHeight: 1.2,
        }
      : {
          fontSize: "16px",
          fontWeight: 400,
          letterSpacing: "-0.1px",
          lineHeight: 1.4,
        };

  return (
    <div>
      <div
        style={{
          fontSize: "12px",
          fontWeight: 500,
          letterSpacing: "0.6px",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontFamily: '"Fira Mono", monospace',
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: "8px",
          color: "var(--text-primary)",
          fontVariantNumeric: "tabular-nums",
          ...valueStyle,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function RankingTable({
  rows,
  totalTokens,
}: {
  rows: RankingRow[];
  totalTokens: number;
}) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "80px 24px",
          textAlign: "center",
          border: "1px solid var(--border-light)",
          borderRadius: "16px",
          background: "white",
          color: "var(--text-secondary)",
          fontSize: "15px",
          fontWeight: 300,
        }}
      >
        No model usage has been aggregated for this period yet.
      </div>
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--border-light)",
        borderRadius: "16px",
        background: "white",
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            minWidth: "640px",
            borderCollapse: "collapse",
            textAlign: "left",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: "72px" }} />
            <col />
            <col style={{ width: "180px" }} />
            <col style={{ width: "100px" }} />
            <col style={{ width: "110px" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={tableHeadCell()}>Rank</th>
              <th style={tableHeadCell()}>Model</th>
              <th style={tableHeadCell({ align: "right" })}>Tokens</th>
              <th style={tableHeadCell({ align: "right" })}>Share</th>
              <th style={tableHeadCell({ align: "right" })}>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const isLast = index === rows.length - 1;
              return (
                <tr key={row.model}>
                  <td style={tableBodyCell({ isLast })}>
                    <span
                      style={{
                        fontFamily: '"Fira Mono", monospace',
                        fontSize: "13px",
                        color: "var(--text-muted)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {String(row.rank).padStart(2, "0")}
                    </span>
                  </td>
                  <td style={tableBodyCell({ isLast })}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          flexShrink: 0,
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          border: "1px solid var(--border-light)",
                          background: "white",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {row.iconPath ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={row.iconPath}
                            alt=""
                            width={20}
                            height={20}
                            style={{ width: 20, height: 20 }}
                          />
                        ) : (
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "var(--text-primary)",
                            }}
                          >
                            {row.name.charAt(0)}
                          </span>
                        )}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 500,
                            color: "var(--text-primary)",
                            letterSpacing: "-0.1px",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {row.name}
                        </div>
                        <div
                          style={{
                            marginTop: 2,
                            fontSize: 13,
                            fontWeight: 300,
                            color: "var(--text-muted)",
                          }}
                        >
                          {row.vendor}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={tableBodyCell({ isLast, align: "right" })}>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatTokens(row.totalTokens)}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 12,
                        fontWeight: 300,
                        color: "var(--text-muted)",
                      }}
                    >
                      {formatTokens(row.inputTokens)} in ·{" "}
                      {formatTokens(row.outputTokens)} out
                    </div>
                  </td>
                  <td style={tableBodyCell({ isLast, align: "right" })}>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 400,
                        color: "var(--text-secondary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatShare(row.share)}
                    </span>
                  </td>
                  <td
                    style={{
                      ...tableBodyCell({ isLast, align: "right" }),
                      fontSize: 14,
                    }}
                  >
                    <ChangeBadge
                      current={row.totalTokens}
                      previous={row.previousTotalTokens}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderTop: "1px solid var(--border-light)",
          fontSize: 13,
          fontWeight: 300,
          color: "var(--text-muted)",
          letterSpacing: "0.1px",
        }}
      >
        <span>Top 50 models by token usage</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {formatTokens(totalTokens)} tokens ranked
        </span>
      </div>
    </div>
  );
}

function tableHeadCell({
  align,
}: { align?: "right" } = {}): React.CSSProperties {
  return {
    padding: "16px 24px",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.8px",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    fontFamily: '"Fira Mono", monospace',
    textAlign: align ?? "left",
    borderBottom: "1px solid var(--border-light)",
    background: "transparent",
  };
}

function tableBodyCell({
  isLast,
  align,
}: { isLast?: boolean; align?: "right" } = {}): React.CSSProperties {
  return {
    padding: "16px 24px",
    textAlign: align ?? "left",
    verticalAlign: "middle",
    borderBottom: isLast ? "none" : "1px solid var(--border-light)",
  };
}

export default async function RankingsPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const activePeriod = parsePeriod(resolvedSearchParams.view);
  const rankings = await getRankings(activePeriod);
  const windowLabel = formatWindow(rankings.windowStart, rankings.windowEnd);

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `${BASE_URL}/${locale}`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "AI Model Rankings",
        item: `${BASE_URL}/${locale}/rankings`,
      },
    ],
  };

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <script type="application/ld+json" suppressHydrationWarning>
        {JSON.stringify(breadcrumbJsonLd)}
      </script>
      <Particles />

      <section className="hero-section" style={{ paddingBottom: "32px" }}>
        <div className="container">
          <h1 className="hero-title">AI Model Rankings</h1>
          <p className="hero-description">
            VM0 model usage ranked by hourly token totals across the selected
            UTC window.
          </p>
          <div style={{ marginTop: "32px" }}>
            <PeriodTabs active={activePeriod} locale={locale} />
          </div>
        </div>
      </section>

      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "24px",
              padding: "32px 0",
              borderTop: "1px solid var(--border-light)",
              borderBottom: "1px solid var(--border-light)",
              marginBottom: "40px",
            }}
          >
            <StatBlock label="Models" value={String(rankings.rows.length)} />
            <StatBlock
              label="Ranked tokens"
              value={formatTokens(rankings.totalTokens)}
            />
            <StatBlock label="Window" value={windowLabel} variant="sm" />
          </div>

          <RankingTable
            rows={rankings.rows}
            totalTokens={rankings.totalTokens}
          />
        </div>
      </section>

      <Footer />
    </div>
  );
}
