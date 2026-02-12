"use client";

import Image from "next/image";
import { useSearchParams, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "../../../navigation";
import Particles from "../Particles";
import type { BlogPost } from "../../lib/blog/types";
import { getBlogBaseUrl } from "../../lib/blog/config";

interface BlogContentProps {
  posts: BlogPost[];
  featuredPost: BlogPost | null;
  categories: string[];
}

export default function BlogContent({
  posts,
  featuredPost,
  categories,
}: BlogContentProps) {
  const searchParams = useSearchParams();
  const params = useParams();
  const locale = (params.locale as string) || "en";
  const categoryFilter = searchParams.get("category");
  const t = useTranslations("blog");

  const filteredPosts = categoryFilter
    ? posts.filter(
        (post) => post.category.toLowerCase() === categoryFilter.toLowerCase(),
      )
    : posts;

  const regularPosts = filteredPosts.filter((post) => !post.featured);

  return (
    <>
      <Particles />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">{t("title")}</h1>
            <p className="hero-description">{t("description")}</p>
          </div>
        </div>
      </section>

      {/* Featured Post */}
      {featuredPost && !categoryFilter && (
        <section className="section-spacing" style={{ paddingTop: 0 }}>
          <div className="container">
            <Link
              href={`/blog/posts/${featuredPost.slug}`}
              style={{ textDecoration: "none" }}
            >
              <article className="featured-post">
                <div className="featured-post-content">
                  <div className="featured-post-meta">
                    <span className="featured-post-category">
                      {featuredPost.category}
                    </span>
                    <span className="featured-post-date">
                      {new Date(featuredPost.publishedAt).toLocaleDateString(
                        locale,
                        {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        },
                      )}
                    </span>
                  </div>
                  <h2 className="featured-post-title">{featuredPost.title}</h2>
                  <p className="featured-post-excerpt">
                    {featuredPost.excerpt}
                  </p>
                </div>
                <div className="featured-post-visual">
                  <Image
                    src={featuredPost.cover}
                    alt={featuredPost.title}
                    width={800}
                    height={500}
                    style={{ width: "100%", height: "auto" }}
                  />
                </div>
              </article>
            </Link>
          </div>
        </section>
      )}

      {/* Category Filter */}
      <section style={{ paddingBottom: "20px" }}>
        <div className="container">
          <div className="category-filter">
            <Link
              href="/blog"
              className={`category-btn ${!categoryFilter ? "active" : ""}`}
            >
              {t("allPosts")}
            </Link>
            {categories.map((category) => (
              <Link
                key={category}
                href={`/blog?category=${category.toLowerCase()}`}
                className={`category-btn ${
                  categoryFilter?.toLowerCase() === category.toLowerCase()
                    ? "active"
                    : ""
                }`}
              >
                {category}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Blog Grid */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          {categoryFilter && (
            <h2
              className="section-title"
              style={{ marginBottom: "40px", textTransform: "capitalize" }}
            >
              {categoryFilter}
            </h2>
          )}
          <div className="blog-grid">
            {regularPosts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/posts/${post.slug}`}
                style={{ textDecoration: "none" }}
              >
                <article className="blog-card">
                  <div className="blog-card-cover">
                    <Image
                      src={post.cover}
                      alt={post.title}
                      fill
                      style={{ objectFit: "cover" }}
                    />
                  </div>
                  <div className="blog-card-body">
                    <div className="blog-card-meta">
                      <span className="blog-card-category">
                        {post.category}
                      </span>
                      <span className="blog-card-date">
                        {new Date(post.publishedAt).toLocaleDateString(locale, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    <h3 className="blog-card-title">{post.title}</h3>
                    <p className="blog-card-excerpt">{post.excerpt}</p>
                    <div className="blog-card-footer">
                      <div className="blog-card-author">
                        <div className="blog-card-avatar">
                          {post.author.avatar ? (
                            <Image
                              src={post.author.avatar}
                              alt={post.author.name}
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
                            post.author.name.charAt(0)
                          )}
                        </div>
                        <span className="blog-card-author-name">
                          {post.author.name}
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
    </>
  );
}
