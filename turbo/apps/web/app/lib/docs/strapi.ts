import { env } from "../../../src/env";
import type { DocsPage, DocsSection } from "./types";

function getStrapiUrl(): string {
  const url = env().NEXT_PUBLIC_STRAPI_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_STRAPI_URL environment variable is not configured",
    );
  }
  return url;
}

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

async function parseJsonResponse<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(`Strapi returned empty response for ${url}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(
      `Strapi returned invalid JSON for ${url}: ${text.slice(0, 200)}`,
      { cause },
    );
  }
}

interface StrapiBlock {
  __component: string;
  id: number;
  body?: string;
  title?: string;
}

interface StrapiDocsSection {
  title?: string;
  name?: string;
  slug?: string;
  order?: number;
}

interface StrapiDocsPage {
  id: number;
  documentId?: string;
  title: string;
  description?: string;
  slug?: string;
  path?: string;
  body?: string;
  content?: string;
  order?: number;
  createdAt: string;
  updatedAt?: string;
  publishedAt?: string;
  section?: StrapiDocsSection;
  blocks?: StrapiBlock[];
}

function normalizeDocsPath(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "docs";
}

function getBlockContent(blocks: StrapiBlock[] | undefined): string {
  if (!blocks?.length) return "";

  return blocks
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

function resolvePathAndSlug(page: StrapiDocsPage): {
  path: string;
  slug: string;
} {
  const fallbackSlug = String(page.id);
  const path = normalizeDocsPath(
    page.path || page.slug || page.documentId || fallbackSlug,
  );
  const slug =
    path.split("/").filter(Boolean).at(-1) || page.slug || fallbackSlug;
  return { path, slug };
}

function resolveSection(section: StrapiDocsSection | undefined): DocsSection {
  const sectionTitle = section?.title || section?.name || "Docs";
  const sectionSlug = section?.slug || slugify(sectionTitle);
  return {
    title: sectionTitle,
    slug: sectionSlug,
    order: section?.order ?? 0,
  };
}

function resolveContent(page: StrapiDocsPage): string {
  const candidates = [
    page.body,
    page.content,
    getBlockContent(page.blocks),
    page.description,
  ];
  return (
    candidates.find((candidate) => {
      return Boolean(candidate);
    }) || ""
  );
}

function transformDocsPage(page: StrapiDocsPage): DocsPage {
  const { path, slug } = resolvePathAndSlug(page);
  const content = resolveContent(page);
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
  const readTime = Math.max(1, Math.ceil(wordCount / 200));
  const updatedAt = page.updatedAt || page.publishedAt || page.createdAt;
  const publishedAt = page.publishedAt || page.createdAt;

  return {
    path,
    slug,
    title: page.title,
    description: page.description || "",
    content,
    section: resolveSection(page.section),
    order: page.order ?? 0,
    publishedAt,
    updatedAt,
    readTime: `${readTime} min read`,
  };
}

function compareDocsPages(a: DocsPage, b: DocsPage): number {
  return (
    a.section.order - b.section.order ||
    a.section.title.localeCompare(b.section.title) ||
    a.order - b.order ||
    a.title.localeCompare(b.title)
  );
}

function buildBaseDocsParams(locale: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set("locale", locale);
  params.set("pagination[pageSize]", "100");
  params.append("populate[0]", "section");
  params.append("populate[1]", "blocks");
  params.append("sort[0]", "order:asc");
  params.append("sort[1]", "title:asc");
  return params;
}

export async function getDocsPagesFromStrapi(
  locale: string = "en",
): Promise<DocsPage[]> {
  const params = buildBaseDocsParams(locale);
  const url = `${getStrapiUrl()}/api/docs-pages?${params.toString()}`;

  const res = await fetch(url, {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    return [];
  }

  if (!res.ok) {
    throw new Error(
      `Failed to fetch docs pages: ${res.status} ${res.statusText}`,
    );
  }

  const data = await parseJsonResponse<StrapiResponse<StrapiDocsPage[]>>(
    res,
    url,
  );
  return data.data.map(transformDocsPage).sort(compareDocsPages);
}

export async function getDocsPageByPathFromStrapi(
  path: string,
  locale: string = "en",
  options: { draft?: boolean } = {},
): Promise<DocsPage | null> {
  const normalizedPath = normalizeDocsPath(path);
  const params = buildBaseDocsParams(locale);
  params.set("filters[$or][0][path][$eq]", normalizedPath);
  params.set("filters[$or][1][slug][$eq]", normalizedPath);
  if (options.draft) {
    params.set("status", "draft");
  }

  const url = `${getStrapiUrl()}/api/docs-pages?${params.toString()}`;

  const res = await fetch(url, {
    ...(options.draft
      ? { cache: "no-store" as const }
      : { next: { revalidate: 3600 } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(
      `Failed to fetch docs page: ${res.status} ${res.statusText}`,
    );
  }

  const data = await parseJsonResponse<StrapiResponse<StrapiDocsPage[]>>(
    res,
    url,
  );

  if (data.data.length === 0) {
    return null;
  }

  return transformDocsPage(data.data[0]!);
}
