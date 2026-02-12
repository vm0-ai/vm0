import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getTranslations } from "next-intl/server";
import { Link } from "../../../../../navigation";
import Particles from "../../../../components/Particles";
import Navbar from "../../../../components/Navbar";
import Footer from "../../../../components/Footer";
import { ShareButtons } from "../../../../components/blog";
import { getPost, getPosts, getBlogBaseUrl } from "../../../../lib/blog";
import { locales } from "../../../../../i18n";
import { isBlogEnabled } from "../../../../../src/env";

export const revalidate = 60;

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  // Skip blog metadata in self-hosted mode (no Strapi available)
  if (!isBlogEnabled()) {
    return { title: "Not Found" };
  }

  const { slug, locale } = await params;
  const post = await getPost(slug, locale);

  if (!post) {
    return { title: "Post Not Found" };
  }

  const postUrl = `${getBlogBaseUrl()}/${locale}/blog/posts/${slug}`;
  const imageUrl = post.cover.startsWith("http")
    ? post.cover
    : `${getBlogBaseUrl()}${post.cover}`;

  return {
    title: post.title,
    description: post.excerpt,
    alternates: {
      canonical: postUrl,
    },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: "article",
      publishedTime: post.publishedAt,
      authors: [post.author.name],
      url: postUrl,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: post.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
      images: [imageUrl],
      creator: "@vm0_ai",
    },
  };
}

export async function generateStaticParams() {
  // Skip static blog pages in self-hosted mode (no Strapi available)
  if (!isBlogEnabled()) {
    return [];
  }

  const params: { slug: string; locale: string }[] = [];

  for (const locale of locales) {
    const posts = await getPosts(locale);
    posts.forEach((post) => {
      params.push({ slug: post.slug, locale });
    });
  }

  return params;
}

export default async function BlogPostPage({ params }: PageProps) {
  if (!isBlogEnabled()) {
    notFound();
  }

  const { slug, locale } = await params;
  const post = await getPost(slug, locale);

  if (!post) {
    notFound();
  }

  const t = await getTranslations("blog");

  const allPosts = await getPosts(locale);
  const relatedPosts = allPosts
    .filter((p) => p.category === post.category && p.slug !== post.slug)
    .slice(0, 3);

  return (
    <>
      <Navbar />
      <Particles />

      {/* Post Header */}
      <header className="blog-post-header">
        <div className="container-narrow">
          <Link href="/blog" className="blog-post-back">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            {t("backToAllPosts")}
          </Link>
          <span className="blog-post-category">{post.category}</span>
          <h1 className="blog-post-title">{post.title}</h1>
          <div className="blog-post-meta">
            <div className="blog-post-author">
              <div className="blog-post-avatar">
                {post.author.avatar ? (
                  <Image
                    src={post.author.avatar}
                    alt={post.author.name}
                    width={44}
                    height={44}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      borderRadius: "50%",
                    }}
                  />
                ) : (
                  post.author.name.charAt(0)
                )}
              </div>
              <div className="blog-post-author-info">
                <span className="blog-post-author-name">
                  {post.author.name}
                </span>
                <span className="blog-post-date">
                  {new Date(post.publishedAt).toLocaleDateString(locale, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>
            <span className="blog-post-read-time">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {post.readTime}
            </span>
          </div>
        </div>
      </header>

      {/* Post Content */}
      <article className="blog-post-content">
        <div className="container-narrow">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {post.content}
          </ReactMarkdown>
        </div>
      </article>

      {/* Share Section */}
      <div className="container-narrow">
        <ShareButtons
          title={post.title}
          url={`${getBlogBaseUrl()}/${locale}/blog/posts/${post.slug}`}
        />
      </div>

      {/* Related Posts */}
      {relatedPosts.length > 0 && (
        <section className="section-spacing">
          <div className="container">
            <h2 className="section-title" style={{ marginBottom: "40px" }}>
              {t("relatedArticles")}
            </h2>
            <div className="blog-grid">
              {relatedPosts.map((relatedPost) => (
                <Link
                  key={relatedPost.slug}
                  href={`/blog/posts/${relatedPost.slug}`}
                  style={{ textDecoration: "none" }}
                >
                  <article className="blog-card">
                    <div className="blog-card-cover">
                      <Image
                        src={relatedPost.cover}
                        alt={relatedPost.title}
                        fill
                        style={{ objectFit: "cover" }}
                      />
                    </div>
                    <div className="blog-card-body">
                      <div className="blog-card-meta">
                        <span className="blog-card-category">
                          {relatedPost.category}
                        </span>
                        <span className="blog-card-date">
                          {new Date(relatedPost.publishedAt).toLocaleDateString(
                            locale,
                            { month: "short", day: "numeric", year: "numeric" },
                          )}
                        </span>
                      </div>
                      <h3 className="blog-card-title">{relatedPost.title}</h3>
                      <p className="blog-card-excerpt">{relatedPost.excerpt}</p>
                      <div className="blog-card-footer">
                        <div className="blog-card-author">
                          <div className="blog-card-avatar">
                            {relatedPost.author.avatar ? (
                              <Image
                                src={relatedPost.author.avatar}
                                alt={relatedPost.author.name}
                                width={32}
                                height={32}
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  objectFit: "cover",
                                  borderRadius: "50%",
                                }}
                              />
                            ) : (
                              relatedPost.author.name.charAt(0)
                            )}
                          </div>
                          <span className="blog-card-author-name">
                            {relatedPost.author.name}
                          </span>
                        </div>
                        <span className="blog-card-read-more">
                          {t("readMore")}
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="5" y1="12" x2="19" y2="12" />
                            <polyline points="12 5 19 12 12 19" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </article>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA Section */}
      <section className="cta-final">
        <div className="container">
          <div className="cta-card">
            <div className="cta-ellipse"></div>
            <h2 className="cta-title">{t("stayInLoop")}</h2>
            <p className="cta-subtitle">{t("stayInLoopDesc")}</p>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <a
                href={`${getBlogBaseUrl()}/sign-up`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary-large"
              >
                {t("subscribe")}
              </a>
              <a
                href="https://discord.gg/WMpAmHFfp6"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary-large"
              >
                {t("joinDiscord")}
              </a>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
