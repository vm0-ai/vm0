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
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import { isBlogEnabled } from "../../../src/env";

export const revalidate = 60;

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
    alternates: {
      canonical: `${getBlogBaseUrl()}/${locale}/blog`,
    },
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

  return (
    <>
      <Navbar />
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
