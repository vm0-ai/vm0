import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getPosts,
  getFeatured,
  getCategories,
  getBlogBaseUrl,
} from "../../lib/blog";
import { BlogContent } from "../../components/blog";
import { Footer } from "../../components/Footer";
import { isBlogEnabled } from "../../../src/env";
import type { Locale } from "../../../i18n";
import { buildLocaleAlternates } from "../../lib/seo/alternates";

const BASE_URL = "https://www.vm0.ai";

function getBreadcrumbJsonLd(locale: string) {
  return {
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
        name: "Blog",
        item: `${BASE_URL}/${locale}/blog`,
      },
    ],
  };
}

export const revalidate = 3600;

interface BlogPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: BlogPageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "blog" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/blog", locale as Locale),
    openGraph: {
      title: `VM0 ${t("title")}`,
      description: t("description"),
      url: `${getBlogBaseUrl()}/${locale}/blog`,
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

export default async function BlogPage({ params }: BlogPageProps) {
  if (!isBlogEnabled()) {
    notFound();
  }

  const { locale } = await params;

  const [posts, featuredPost, categories] = await Promise.all([
    getPosts(locale),
    getFeatured(locale),
    getCategories(locale),
  ]);

  const breadcrumbJsonLd = getBreadcrumbJsonLd(locale);

  return (
    <>
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <Suspense
        fallback={
          <div
            style={{
              minHeight: "100vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ color: "rgba(255, 255, 255, 0.5)" }}>Loading...</div>
          </div>
        }
      >
        <BlogContent
          posts={posts}
          featuredPost={featuredPost}
          categories={categories}
        />
      </Suspense>
      <Footer />
    </>
  );
}
