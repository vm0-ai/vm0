"use client";

import { useTranslations } from "next-intl";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import {
  type PeriodKey,
  PERIODS,
  formatTokens,
  formatShare,
  formatChange,
} from "./data";

interface SerializedRankingRow {
  rank: number;
  model: string;
  name: string;
  vendor: string;
  iconPath: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  previousTotalTokens: number;
  share: number;
}

interface RankingsPageProps {
  locale: string;
  activePeriod: PeriodKey;
  rankings: {
    rows: SerializedRankingRow[];
    totalTokens: number;
    windowStart: string;
    windowEnd: string;
  };
}

function PeriodTabs({
  active,
  locale,
}: {
  active: PeriodKey;
  locale: string;
}) {
  const t = useTranslations("rankingsPage");

  return (
    <div
      className="inline-flex rounded-lg border border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-50))] p-1"
      role="tablist"
      aria-label={t("periodAriaLabel")}
    >
      {PERIODS.map((period) => {
        const isActive = active === period.key;
        return (
          <a
            key={period.key}
            href={`/${locale}/rankings?view=${period.key}`}
            role="tab"
            aria-selected={isActive}
            className={`rounded-md px-4 py-2 text-[13px] font-medium transition-all ${
              isActive
                ? "bg-[hsl(var(--foreground))] text-[hsl(var(--background))] shadow-sm"
                : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
            }`}
          >
            {period.key === "today"
              ? t("periodToday")
              : period.key === "week"
                ? t("periodWeek")
                : t("periodMonth")}
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
  const baseClass =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium";

  if (change.tone === "up") {
    return (
      <span className={`${baseClass} bg-emerald-50 text-emerald-700`}>
        {change.label}
      </span>
    );
  }
  if (change.tone === "down") {
    return (
      <span className={`${baseClass} bg-red-50 text-red-700`}>
        {change.label}
      </span>
    );
  }
  if (change.tone === "new") {
    return (
      <span className={`${baseClass} bg-blue-50 text-blue-700`}>
        {change.label}
      </span>
    );
  }
  return (
    <span className="text-[13px] text-[hsl(var(--muted-foreground))]">
      {change.label}
    </span>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-0))] px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {label}
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-tight text-[hsl(var(--foreground))]">
        {value}
      </div>
    </div>
  );
}

export function RankingsPage({
  locale,
  activePeriod,
  rankings,
}: RankingsPageProps) {
  const t = useTranslations("rankingsPage");
  const windowStart = new Date(rankings.windowStart);
  const windowEnd = new Date(rankings.windowEnd);

  const updatedThrough =
    windowEnd <= windowStart
      ? t("windowPending")
      : `${windowStart.toISOString().slice(0, 10)} — ${windowEnd.toISOString().replace(".000Z", "")} UTC`;

  return (
    <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
      <Particles />

      <main className="pb-20 pt-[calc(var(--total-header-height)+44px)] md:pb-28 md:pt-[calc(var(--total-header-height)+64px)]">
        <div className="mx-auto max-w-[1120px] px-6">
          {/* Header */}
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
                {t("heading")}
              </h1>
              <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                {t("subtitle")}
              </p>
            </div>
            <PeriodTabs active={activePeriod} locale={locale} />
          </div>

          {/* Summary stats */}
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label={t("statModels")}
              value={String(rankings.rows.length)}
            />
            <StatCard
              label={t("statTokens")}
              value={formatTokens(rankings.totalTokens)}
            />
            <StatCard label={t("statWindow")} value={updatedThrough} />
          </div>

          {/* Table */}
          <section className="mt-8">
            {rankings.rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-[hsl(var(--gray-200))] py-20">
                <p className="text-[15px] font-medium text-[hsl(var(--foreground))]">
                  {t("emptyTitle")}
                </p>
                <p className="text-[14px] text-[hsl(var(--muted-foreground))]">
                  {t("emptyMessage")}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-[hsl(var(--gray-200))]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-50))] text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                        <th className="w-[64px] px-4 py-3.5">
                          {t("tableRank")}
                        </th>
                        <th className="px-4 py-3.5">{t("tableModel")}</th>
                        <th className="px-4 py-3.5 text-right">
                          {t("tableTokens")}
                        </th>
                        <th className="px-4 py-3.5 text-right">
                          {t("tableShare")}
                        </th>
                        <th className="px-4 py-3.5 text-right">
                          {t("tableChange")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankings.rows.map((row) => {
                        return (
                          <tr
                            key={row.model}
                            className="border-b border-[hsl(var(--gray-100))] transition-colors hover:bg-[hsl(var(--gray-50))]/50 last:border-b-0"
                          >
                            <td className="px-4 py-3.5 text-[14px] tabular-nums text-[hsl(var(--muted-foreground))]">
                              {row.rank}
                            </td>
                            <td className="px-4 py-3.5">
                              <div className="flex min-w-0 items-center gap-3">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--gray-200))] bg-white">
                                  {row.iconPath ? (
                                    /* eslint-disable-next-line @next/next/no-img-element */
                                    <img
                                      src={row.iconPath}
                                      alt=""
                                      width={20}
                                      height={20}
                                      className="h-5 w-5"
                                    />
                                  ) : (
                                    <span className="text-[12px] font-semibold text-[hsl(var(--foreground))]">
                                      {row.name.charAt(0)}
                                    </span>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="truncate text-[14px] font-medium text-[hsl(var(--foreground))]">
                                    {row.name}
                                  </div>
                                  <div className="truncate text-[12px] text-[hsl(var(--muted-foreground))]">
                                    {row.vendor}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              <div className="text-[14px] font-medium tabular-nums text-[hsl(var(--foreground))]">
                                {formatTokens(row.totalTokens)}
                              </div>
                              <div className="text-[11px] text-[hsl(var(--muted-foreground))]">
                                {t("inputOutput", {
                                  inputCount: formatTokens(row.inputTokens),
                                  outputCount: formatTokens(row.outputTokens),
                                })}
                              </div>
                            </td>
                            <td className="px-4 py-3.5 text-right text-[14px] tabular-nums text-[hsl(var(--foreground))]">
                              {formatShare(row.share)}
                            </td>
                            <td className="px-4 py-3.5 text-right">
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

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--gray-200))] bg-[hsl(var(--gray-50))] px-4 py-3 text-[12px] text-[hsl(var(--muted-foreground))]">
                  <span>{t("tableFooter")}</span>
                  <span>
                    {t("tableFooterTokens", {
                      count: formatTokens(rankings.totalTokens),
                    })}
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
