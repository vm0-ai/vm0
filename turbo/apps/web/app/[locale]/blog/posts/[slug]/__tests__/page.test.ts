import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";

const STRAPI_URL = "https://test-strapi.example.com" as const;

const mockArticle = {
  id: 1,
  documentId: "doc-1",
  title: "Test Post",
  description: "Test excerpt",
  slug: "test-post",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  publishedAt: "2024-01-01T00:00:00.000Z",
  cover: { url: "/covers/test.jpg" },
  author: { name: "Test Author" },
  category: { name: "Technology", slug: "technology" },
  blocks: [{ __component: "shared.rich-text", id: 1, body: "Test content" }],
};

// Set env vars before any module loads
vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://test.vm0.ai");
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://test-strapi.example.com");
});

// External: next-intl/server (used by page.tsx and i18n.ts)
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `mock-${key}`),
  getRequestConfig: vi.fn((fn: unknown) => fn),
}));

// External: next-intl/navigation (used by navigation.ts → Link)
vi.mock("next-intl/navigation", () => ({
  createNavigation: vi.fn(() => ({
    Link: () => null,
    redirect: vi.fn(),
    usePathname: vi.fn(),
    useRouter: vi.fn(),
  })),
}));

// External: next-intl (used by Navbar, Footer, ShareButtons)
vi.mock("next-intl", () => ({
  useTranslations: vi.fn(() => (key: string) => `mock-${key}`),
}));

// External: @clerk/nextjs (used by Navbar)
vi.mock("@clerk/nextjs", () => ({
  useUser: vi.fn(() => ({ user: null, isLoaded: true })),
  useClerk: vi.fn(() => ({ signOut: vi.fn() })),
}));

// External: next/navigation (used by BlogContent, notFound)
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  useRouter: vi.fn(() => ({})),
}));

import { generateMetadata } from "../page";

describe("blog post page metadata", () => {
  beforeEach(() => {
    server.use(
      http.get(`${STRAPI_URL}/api/articles`, ({ request }) => {
        const url = new URL(request.url);
        const slug = url.searchParams.get("filters[slug][$eq]");
        if (slug === "test-post") {
          return HttpResponse.json({ data: [mockArticle], meta: {} });
        }
        return HttpResponse.json({ data: [], meta: {} });
      }),
    );
  });

  it("includes canonical URL for existing post", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "test-post", locale: "en" }),
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://test.vm0.ai/en/blog/posts/test-post",
    );
  });

  it("uses locale in canonical URL", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "test-post", locale: "ja" }),
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://test.vm0.ai/ja/blog/posts/test-post",
    );
  });

  it("returns no canonical URL when post does not exist", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "non-existent", locale: "en" }),
    });

    expect(metadata.title).toBe("Post Not Found");
    expect(metadata.alternates).toBeUndefined();
  });
});
