import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";

import { type Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { initServices } from "../../../src/lib/init-services";
import { MODELS, vendorIconPath, type ModelEntry } from "../models/data";

const BASE_URL = "https://www.vm0.ai";
const MAX_WIDTH = 1120;
const PAGE_PADDING = 24;
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
  readonly providers: string;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly totalTokens: number;
  readonly creditsCharged: number;
  readonly previousTotalTokens: number;
  readonly share: number;
}

interface RawRankingRow {
  readonly model: unknown;
  readonly providers: unknown;
  readonly request_count: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_tokens: unknown;
  readonly total_tokens: unknown;
  readonly credits_charged: unknown;
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

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
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
  const direct = MODELS_BY_ID.get(modelId.toLowerCase());
  if (direct) return direct;

  const [, suffix] = modelId.split("/");
  if (!suffix) return undefined;

  return MODELS_BY_ID.get(suffix.toLowerCase());
}

function titleizeModelId(modelId: string): string {
  const suffix = modelId.split("/").at(-1) ?? modelId;
  return suffix
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
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

  const result = await globalThis.services.db.execute(sql`
    WITH current_period AS (
      SELECT
        ${modelStat.model} AS model,
        COALESCE(string_agg(DISTINCT NULLIF(${modelStat.modelProvider}, ''), ', '), '') AS providers,
        COALESCE(SUM(${modelStat.requestCount}), 0)::bigint AS request_count,
        COALESCE(SUM(${modelStat.inputTokens}), 0)::bigint AS input_tokens,
        COALESCE(SUM(${modelStat.outputTokens}), 0)::bigint AS output_tokens,
        COALESCE(SUM(${modelStat.cacheReadInputTokens} + ${modelStat.cacheCreationInputTokens}), 0)::bigint AS cache_tokens,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS total_tokens,
        COALESCE(SUM(${modelStat.creditsCharged}), 0)::bigint AS credits_charged
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${window.start}
        AND ${modelStat.hourStart} < ${window.end}
      GROUP BY ${modelStat.model}
    ),
    previous_period AS (
      SELECT
        ${modelStat.model} AS model,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS previous_total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${previousStart}
        AND ${modelStat.hourStart} < ${previousEnd}
      GROUP BY ${modelStat.model}
    )
    SELECT
      current_period.model,
      current_period.providers,
      current_period.request_count,
      current_period.input_tokens,
      current_period.output_tokens,
      current_period.cache_tokens,
      current_period.total_tokens,
      current_period.credits_charged,
      COALESCE(previous_period.previous_total_tokens, 0)::bigint AS previous_total_tokens
    FROM current_period
    LEFT JOIN previous_period ON previous_period.model = current_period.model
    WHERE current_period.total_tokens > 0
    ORDER BY current_period.total_tokens DESC
    LIMIT 50
  `);

  const rawRows = result.rows as unknown as RawRankingRow[];
  const totalTokens = rawRows.reduce((sum, row) => {
    return sum + toNumber(row.total_tokens);
  }, 0);

  return {
    totalTokens,
    windowStart: window.start,
    windowEnd: window.end,
    rows: rawRows.map((row, index) => {
      const model = String(row.model);
      const modelEntry = resolveModel(model);
      const rowTotalTokens = toNumber(row.total_tokens);
      return {
        rank: index + 1,
        model,
        name: modelEntry?.name ?? titleizeModelId(model),
        vendor: modelEntry?.vendor ?? "External",
        iconPath: modelEntry ? vendorIconPath(modelEntry.vendor) : null,
        providers: String(row.providers ?? ""),
        requestCount: toNumber(row.request_count),
        inputTokens: toNumber(row.input_tokens),
        outputTokens: toNumber(row.output_tokens),
        cacheTokens: toNumber(row.cache_tokens),
        totalTokens: rowTotalTokens,
        creditsCharged: toNumber(row.credits_charged),
        previousTotalTokens: toNumber(row.previous_total_tokens),
        share: totalTokens > 0 ? (rowTotalTokens / totalTokens) * 100 : 0,
      };
    }),
  };
}

function PeriodTabs({ active, locale }: { active: PeriodKey; locale: string }) {
  return (
    <div
      className="inline-flex rounded-lg border border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-50))] p-1"
      role="tablist"
      aria-label="Ranking period"
    >
      {PERIODS.map((period) => {
        const isActive = active === period.key;
        return (
          <a
            key={period.key}
            href={`/${locale}/rankings?view=${period.key}`}
            role="tab"
            aria-selected={isActive}
            className={`rounded-md px-3 py-2 text-[14px] font-medium transition-colors ${
              isActive
                ? "bg-[hsl(var(--foreground))] text-[hsl(var(--background))]"
                : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
            }`}
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
  const className =
    change.tone === "up" || change.tone === "new"
      ? "text-emerald-600"
      : change.tone === "down"
        ? "text-red-500"
        : "text-[hsl(var(--muted-foreground))]";

  return <span className={className}>{change.label}</span>;
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
      <div className="border-y border-[hsl(var(--gray-200))] py-16 text-center">
        <p className="text-[15px] text-[hsl(var(--muted-foreground))]">
          No model usage has been aggregated for this period yet.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border-y border-[hsl(var(--gray-200))]">
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-b border-[hsl(var(--gray-200))] text-[12px] uppercase text-[hsl(var(--muted-foreground))]">
            <th className="w-[64px] px-3 py-3 font-medium">Rank</th>
            <th className="px-3 py-3 font-medium">Model</th>
            <th className="px-3 py-3 text-right font-medium">Tokens</th>
            <th className="px-3 py-3 text-right font-medium">Share</th>
            <th className="px-3 py-3 text-right font-medium">Change</th>
            <th className="px-3 py-3 text-right font-medium">Requests</th>
            <th className="px-3 py-3 text-right font-medium">Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const provider = row.providers || row.vendor;
            return (
              <tr
                key={row.model}
                className="border-b border-[hsl(var(--gray-100))] last:border-b-0"
              >
                <td className="px-3 py-4 text-[15px] text-[hsl(var(--muted-foreground))]">
                  {row.rank}
                </td>
                <td className="px-3 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--gray-200))] bg-white">
                      {row.iconPath ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={row.iconPath}
                          alt=""
                          width={22}
                          height={22}
                          className="h-[22px] w-[22px]"
                        />
                      ) : (
                        <span className="text-[13px] font-semibold text-[hsl(var(--foreground))]">
                          {row.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-[hsl(var(--foreground))]">
                        {row.name}
                      </div>
                      <div className="truncate text-[12px] text-[hsl(var(--muted-foreground))]">
                        {provider}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-4 text-right">
                  <div className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                    {formatTokens(row.totalTokens)}
                  </div>
                  <div className="text-[12px] text-[hsl(var(--muted-foreground))]">
                    {formatTokens(row.inputTokens)} in /{" "}
                    {formatTokens(row.outputTokens)} out
                  </div>
                </td>
                <td className="px-3 py-4 text-right text-[14px] text-[hsl(var(--foreground))]">
                  {formatShare(row.share)}
                </td>
                <td className="px-3 py-4 text-right text-[14px] font-medium">
                  <ChangeBadge
                    current={row.totalTokens}
                    previous={row.previousTotalTokens}
                  />
                </td>
                <td className="px-3 py-4 text-right text-[14px] text-[hsl(var(--foreground))]">
                  {formatCompact(row.requestCount)}
                </td>
                <td className="px-3 py-4 text-right text-[14px] text-[hsl(var(--foreground))]">
                  {formatCompact(row.creditsCharged)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--gray-100))] px-3 py-3 text-[13px] text-[hsl(var(--muted-foreground))]">
        <span>Top 50 models by token usage</span>
        <span>{formatTokens(totalTokens)} tokens in ranked models</span>
      </div>
    </div>
  );
}

export default async function RankingsPage({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const activePeriod = parsePeriod(resolvedSearchParams.view);
  const rankings = await getRankings(activePeriod);
  const updatedThrough =
    rankings.windowEnd <= rankings.windowStart
      ? "waiting for the first completed UTC hour"
      : `${rankings.windowStart.toISOString().slice(0, 10)} to ${rankings.windowEnd.toISOString().replace(".000Z", "Z")}`;

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />
      <main className="pb-20 pt-[calc(var(--total-header-height)+44px)] md:pb-28 md:pt-[calc(var(--total-header-height)+64px)]">
        <section
          className="mx-auto"
          style={{ maxWidth: MAX_WIDTH, padding: `0 ${PAGE_PADDING}px` }}
        >
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-[32px] font-semibold leading-tight tracking-normal sm:text-[40px]">
                AI Model Rankings
              </h1>
              <p className="mt-3 max-w-[680px] text-[16px] font-light leading-relaxed text-[hsl(var(--muted-foreground))]">
                VM0 model usage ranked by hourly token totals across the
                selected UTC window.
              </p>
            </div>
            <PeriodTabs active={activePeriod} locale={locale} />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-3 border-y border-[hsl(var(--gray-200))] py-4 sm:grid-cols-3">
            <div>
              <div className="text-[12px] uppercase text-[hsl(var(--muted-foreground))]">
                Models
              </div>
              <div className="mt-1 text-[24px] font-semibold">
                {rankings.rows.length}
              </div>
            </div>
            <div>
              <div className="text-[12px] uppercase text-[hsl(var(--muted-foreground))]">
                Ranked tokens
              </div>
              <div className="mt-1 text-[24px] font-semibold">
                {formatTokens(rankings.totalTokens)}
              </div>
            </div>
            <div>
              <div className="text-[12px] uppercase text-[hsl(var(--muted-foreground))]">
                Window
              </div>
              <div className="mt-1 text-[14px] leading-8 text-[hsl(var(--foreground))]">
                {updatedThrough}
              </div>
            </div>
          </div>

          <section className="mt-8">
            <RankingTable
              rows={rankings.rows}
              totalTokens={rankings.totalTokens}
            />
          </section>
        </section>
      </main>
      <Footer />
    </div>
  );
}
