import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getTranslations } from "next-intl/server";
import { Footer } from "../../../components/Footer";
import { Particles } from "../../../components/Particles";
import { DocsShell } from "../../../components/docs/DocsShell";
import {
  canViewDocs,
  getDocsAvailableLocales,
  getDocsBaseUrl,
  getDocsNavigation,
  getDocsPage,
} from "../../../lib/docs";
import { buildLocaleAlternates } from "../../../lib/seo/alternates";
import { locales, type Locale } from "../../../../i18n";
import { Link } from "../../../../navigation";

interface DocsPageProps {
  params: Promise<{ locale: string; slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const dynamic = "force-dynamic";

function pathFromSlug(slug: string[]): string {
  return slug.join("/");
}

function titlesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function stripDuplicateLeadingHeading(content: string, title: string): string {
  const match = content.match(/^\s*#{1,3}\s+(.+?)\s*\n+/);
  const heading = match?.[1];
  if (match && heading && titlesMatch(heading, title)) {
    return content.slice(match[0].length);
  }
  return content;
}

export async function generateMetadata({
  params,
  searchParams,
}: DocsPageProps): Promise<Metadata> {
  if (!(await canViewDocs())) {
    return { title: "Not Found" };
  }

  const { locale, slug } = await params;
  const { status } = await searchParams;
  const path = pathFromSlug(slug);
  const page = await getDocsPage(path, locale, { draft: status === "draft" });

  if (!page) {
    return { title: "Docs Page Not Found" };
  }

  return {
    title: page.title,
    description: page.description,
    alternates: buildLocaleAlternates(
      `/docs/${page.path}`,
      locale as Locale,
      (await getDocsAvailableLocales(page.path, locales)) as Locale[],
    ),
    openGraph: {
      title: page.title,
      description: page.description,
      type: "article",
      publishedTime: page.publishedAt,
      modifiedTime: page.updatedAt,
      url: `${getDocsBaseUrl()}/${locale}/docs/${page.path}`,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: page.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
    },
  };
}

export default async function DocsPage({
  params,
  searchParams,
}: DocsPageProps) {
  if (!(await canViewDocs())) {
    notFound();
  }

  const { locale, slug } = await params;
  const { status } = await searchParams;
  const draft = status === "draft";
  const path = pathFromSlug(slug);
  const page = await getDocsPage(path, locale, { draft });

  if (!page) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "docs" });
  const navigation = await getDocsNavigation(locale, { draft });
  const pageUrl = `${getDocsBaseUrl()}/${locale}/docs/${page.path}`;
  const showKicker = !titlesMatch(page.section.title, page.title);
  const articleContent = stripDuplicateLeadingHeading(page.content, page.title);

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: `${getDocsBaseUrl()}/${locale}`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Docs",
        item: `${getDocsBaseUrl()}/${locale}/docs`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: page.title,
        item: pageUrl,
      },
    ],
  };

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    description: page.description,
    url: pageUrl,
    datePublished: page.publishedAt,
    dateModified: page.updatedAt,
    publisher: {
      "@type": "Organization",
      name: "VM0",
      logo: {
        "@type": "ImageObject",
        url: "https://www.vm0.ai/assets/vm0-logo.svg",
      },
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <Particles />
      <DocsShell
        navigation={navigation}
        homeLabel={t("home")}
        activePath={page.path}
        draft={draft}
      >
        <header className="docs-article-header">
          <Link
            href={draft ? "/docs?status=draft" : "/docs"}
            className="blog-post-back"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            {t("backToDocs")}
          </Link>
          {showKicker && (
            <span className="docs-kicker">{page.section.title}</span>
          )}
          <h1 className="docs-title">{page.title}</h1>
          {page.description && (
            <p className="docs-description">{page.description}</p>
          )}
          <p className="docs-updated">
            {t("lastUpdated", {
              date: new Date(page.updatedAt).toLocaleDateString(locale, {
                year: "numeric",
                month: "long",
                day: "numeric",
              }),
            })}
            {" · "}
            {page.readTime}
          </p>
        </header>
        <article className="docs-article blog-post-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {articleContent}
          </ReactMarkdown>
        </article>
      </DocsShell>
      <Footer />
    </>
  );
}
