import { BlogPost } from "./types";

const STRAPI_URL =
  process.env.NEXT_PUBLIC_STRAPI_URL || "http://localhost:1337";

interface StrapiResponse<T> {
  data: T;
  meta: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

interface StrapiBlock {
  __component: string;
  id: number;
  body?: string;
  title?: string;
}

interface StrapiArticle {
  id: number;
  documentId: string;
  title: string;
  description: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  cover?: {
    url: string;
    alternativeText?: string;
  };
  author?: {
    name: string;
    email?: string;
    avatar?: {
      url: string;
    };
  };
  category?: {
    name: string;
    slug: string;
  };
  blocks?: StrapiBlock[];
}

function transformArticle(article: StrapiArticle): BlogPost {
  let coverUrl = "/covers/default.png";
  if (article.cover?.url) {
    const url = article.cover.url;
    coverUrl = url.startsWith("http") ? url : `${STRAPI_URL}${url}`;
  }

  let content = "";
  if (article.blocks && article.blocks.length > 0) {
    content = article.blocks
      .map((block) => {
        if (block.__component === "shared.rich-text" && block.body) {
          return block.body;
        }
        if (block.__component === "shared.quote" && block.body) {
          return `> **${block.title || ""}**\n> ${block.body}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (!content) {
    content = article.description || "";
  }

  const wordCount = content.split(/\s+/).length || 0;
  const readTime = Math.max(1, Math.ceil(wordCount / 200));

  return {
    slug: article.slug,
    title: article.title,
    excerpt: article.description || "",
    content: content,
    category: article.category?.name || "General",
    author: {
      name: article.author?.name || "VM0 Team",
    },
    publishedAt: article.publishedAt || article.createdAt,
    readTime: `${readTime} min read`,
    featured: false,
    cover: coverUrl,
  };
}

export async function getPostsFromStrapi(
  locale: string = "en",
): Promise<BlogPost[]> {
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&populate=*&sort=publishedAt:desc`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return [];
    }

    const data: StrapiResponse<StrapiArticle[]> = await res.json();
    return data.data.map(transformArticle);
  } catch {
    // Return empty array when Strapi is unavailable (e.g., during CI build)
    return [];
  }
}

export async function getPostBySlugFromStrapi(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&filters[slug][$eq]=${slug}&populate=*`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return null;
    }

    const data: StrapiResponse<StrapiArticle[]> = await res.json();

    if (data.data.length === 0) {
      return null;
    }

    return transformArticle(data.data[0]!);
  } catch {
    // Return null when Strapi is unavailable (e.g., during CI build)
    return null;
  }
}

export async function getFeaturedPostFromStrapi(
  locale: string = "en",
): Promise<BlogPost | null> {
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&populate=*&sort=publishedAt:desc&pagination[limit]=1`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return null;
    }

    const data: StrapiResponse<StrapiArticle[]> = await res.json();

    if (data.data.length === 0) {
      return null;
    }

    const post = transformArticle(data.data[0]!);
    post.featured = true;
    return post;
  } catch {
    // Return null when Strapi is unavailable (e.g., during CI build)
    return null;
  }
}

export async function getAllCategoriesFromStrapi(
  locale: string = "en",
): Promise<string[]> {
  try {
    const res = await fetch(`${STRAPI_URL}/api/categories?locale=${locale}`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return [];
    }

    interface StrapiCategory {
      id: number;
      name: string;
      slug: string;
    }

    const data: StrapiResponse<StrapiCategory[]> = await res.json();
    return data.data.map((cat) => cat.name);
  } catch {
    // Return empty array when Strapi is unavailable (e.g., during CI build)
    return [];
  }
}
