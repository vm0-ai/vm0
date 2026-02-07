import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getPosts, getFeatured, getCategories } from "../../lib/blog";
import { BlogContent } from "../../components/blog";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

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
      canonical: `https://vm0.ai/${locale}/blog`,
    },
    openGraph: {
      title: `VM0 ${t("title")}`,
      description: t("description"),
      url: `https://vm0.ai/${locale}/blog`,
    },
  };
}

export default async function BlogPage({ params }: BlogPageProps) {
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
