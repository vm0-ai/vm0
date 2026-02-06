import { BlogPost } from "./types";

function getStrapiUrl(): string {
  const url = process.env.NEXT_PUBLIC_STRAPI_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_STRAPI_URL environment variable is not configured",
    );
  }
  return url;
}

const STRAPI_URL = getStrapiUrl();

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

  let avatarUrl: string | undefined;
  if (article.author?.avatar?.url) {
    const url = article.author.avatar.url;
    avatarUrl = url.startsWith("http") ? url : `${STRAPI_URL}${url}`;
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
      avatar: avatarUrl,
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
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&populate[0]=cover&populate[1]=blocks&populate[2]=category&populate[3]=author.avatar&sort=publishedAt:desc`;

  const res = await fetch(url, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch posts: ${res.status} ${res.statusText}`);
  }

  const data: StrapiResponse<StrapiArticle[]> = await res.json();
  return data.data.map(transformArticle);
}

export async function getPostBySlugFromStrapi(
  slug: string,
  locale: string = "en",
): Promise<BlogPost | null> {
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&filters[slug][$eq]=${slug}&populate[0]=cover&populate[1]=blocks&populate[2]=category&populate[3]=author.avatar`;

  const res = await fetch(url, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch post by slug: ${res.status} ${res.statusText}`,
    );
  }

  const data: StrapiResponse<StrapiArticle[]> = await res.json();

  if (data.data.length === 0) {
    return null;
  }

  return transformArticle(data.data[0]!);
}

export async function getFeaturedPostFromStrapi(
  locale: string = "en",
): Promise<BlogPost | null> {
  const url = `${STRAPI_URL}/api/articles?locale=${locale}&populate[0]=cover&populate[1]=blocks&populate[2]=category&populate[3]=author.avatar&sort=publishedAt:desc&pagination[limit]=1`;

  const res = await fetch(url, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch featured post: ${res.status} ${res.statusText}`,
    );
  }

  const data: StrapiResponse<StrapiArticle[]> = await res.json();

  if (data.data.length === 0) {
    return null;
  }

  const post = transformArticle(data.data[0]!);
  post.featured = true;
  return post;
}

export async function getAllCategoriesFromStrapi(
  locale: string = "en",
): Promise<string[]> {
  const res = await fetch(`${STRAPI_URL}/api/categories?locale=${locale}`, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch categories: ${res.status} ${res.statusText}`,
    );
  }

  interface StrapiCategory {
    id: number;
    name: string;
    slug: string;
  }

  const data: StrapiResponse<StrapiCategory[]> = await res.json();
  return data.data.map((cat) => cat.name);
}
