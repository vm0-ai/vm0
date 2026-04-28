import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Script from "next/script";
import { SecurityPage } from "./SecurityPage";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "securityPage" });
  const url = `${BASE_URL}/${locale}/security`;

  return {
    title: t("pageTitle"),
    description: t("pageDescription"),
    alternates: buildLocaleAlternates("/security", locale as Locale),
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

export default async function SecurityPageServer({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "securityPage" });

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
        name: t("breadcrumbSecurity"),
        item: `${BASE_URL}/${locale}/security`,
      },
    ],
  };

  return (
    <>
      <Script
        id="json-ld-breadcrumb"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <SecurityPage />
    </>
  );
}
