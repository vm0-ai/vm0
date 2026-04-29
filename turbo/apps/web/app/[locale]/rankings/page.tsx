import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Script from "next/script";
import { type Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { RankingsPage } from "./RankingsPage";
import { getRankings, type PeriodKey, PERIODS } from "./data";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function parsePeriod(value: string | string[] | undefined): PeriodKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return PERIODS.some((period) => {
    return period.key === raw;
  })
    ? (raw as PeriodKey)
    : "week";
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rankingsPage" });
  const url = `${BASE_URL}/${locale}/rankings`;

  return {
    title: t("pageTitle"),
    description: t("pageDescription"),
    alternates: buildLocaleAlternates("/rankings", locale as Locale),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url,
      type: "website",
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: t("ogTitle"),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: t("ogTitle"),
      description: t("ogDescription"),
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function RankingsPageServer({
  params,
  searchParams,
}: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rankingsPage" });
  const resolvedSearchParams = (await searchParams) ?? {};
  const activePeriod = parsePeriod(resolvedSearchParams.view);
  const rankings = await getRankings(activePeriod);

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: t("breadcrumbHome"),
        item: `${BASE_URL}/${locale}`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: t("breadcrumbRankings"),
        item: `${BASE_URL}/${locale}/rankings`,
      },
    ],
  };

  const serialized = {
    rows: rankings.rows.map((row) => {
      return {
        rank: row.rank,
        model: row.model,
        name: row.name,
        vendor: row.vendor,
        iconPath: row.iconPath,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheTokens: row.cacheTokens,
        totalTokens: row.totalTokens,
        previousTotalTokens: row.previousTotalTokens,
        share: row.share,
      };
    }),
    totalTokens: rankings.totalTokens,
    windowStart: rankings.windowStart.toISOString(),
    windowEnd: rankings.windowEnd.toISOString(),
  };

  return (
    <>
      <Script
        id="json-ld-breadcrumb"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <RankingsPage
        locale={locale}
        activePeriod={activePeriod}
        rankings={serialized}
      />
    </>
  );
}
