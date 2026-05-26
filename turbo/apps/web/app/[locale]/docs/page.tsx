import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";
import { DocsShell } from "../../components/docs/DocsShell";
import {
  buildDocsNavigation,
  canViewDocs,
  getDocsBaseUrl,
  getDocsPages,
} from "../../lib/docs";
import { buildLocaleAlternates } from "../../lib/seo/alternates";
import { type Locale } from "../../../i18n";
import { Link } from "../../../navigation";

const BASE_URL = "https://www.vm0.ai";

interface DocsIndexPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: DocsIndexPageProps): Promise<Metadata> {
  if (!(await canViewDocs())) {
    return { title: "Not Found" };
  }

  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "docs" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/docs", locale as Locale),
    openGraph: {
      title: `VM0 ${t("title")}`,
      description: t("description"),
      url: `${getDocsBaseUrl()}/${locale}/docs`,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: `VM0 ${t("title")}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `VM0 ${t("title")}`,
      description: t("description"),
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function DocsIndexPage({
  params,
  searchParams,
}: DocsIndexPageProps) {
  if (!(await canViewDocs())) {
    notFound();
  }

  const { locale } = await params;
  const { status } = await searchParams;
  const draft = status === "draft";
  const t = await getTranslations({ locale, namespace: "docs" });
  const pages = await getDocsPages(locale, { draft });
  const navigation = buildDocsNavigation(pages);

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
        name: "Docs",
        item: `${BASE_URL}/${locale}/docs`,
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <Particles />
      <DocsShell navigation={navigation} homeLabel={t("home")} draft={draft}>
        <header className="docs-article-header">
          <p className="docs-kicker">{t("kicker")}</p>
          <h1 className="docs-title">{t("title")}</h1>
          <p className="docs-description">{t("description")}</p>
        </header>
        {pages.length > 0 ? (
          <div className="docs-index-grid">
            {pages.map((page) => {
              return (
                <Link
                  key={page.path}
                  href={
                    draft
                      ? `/docs/${page.path}?status=draft`
                      : `/docs/${page.path}`
                  }
                  className="docs-index-card"
                >
                  <span className="docs-index-section">
                    {page.section.title}
                  </span>
                  <h2>{page.title}</h2>
                  {page.description && <p>{page.description}</p>}
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="docs-empty">{t("empty")}</p>
        )}
      </DocsShell>
      <Footer />
    </>
  );
}
