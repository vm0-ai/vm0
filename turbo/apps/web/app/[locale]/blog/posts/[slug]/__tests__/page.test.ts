import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../../src/env";

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

// External: next-intl/server (used by page.tsx and i18n.ts)
vi.mock("next-intl/server", () => {
  return {
    getTranslations: vi.fn(async () => {
      return (key: string) => {
        return `mock-${key}`;
      };
    }),
    getRequestConfig: vi.fn((fn: unknown) => {
      return fn;
    }),
  };
});

// External: next-intl/navigation (used by navigation.ts → Link)
vi.mock("next-intl/navigation", () => {
  return {
    createNavigation: vi.fn(() => {
      return {
        Link: () => {
          return null;
        },
        redirect: vi.fn(),
        usePathname: vi.fn(),
        useRouter: vi.fn(),
      };
    }),
  };
});

// External: next-intl (used by Navbar, Footer, ShareButtons)
vi.mock("next-intl", () => {
  return {
    useTranslations: vi.fn(() => {
      return (key: string) => {
        return `mock-${key}`;
      };
    }),
  };
});

// External: @clerk/nextjs (used by Navbar)
vi.mock("@clerk/nextjs", () => {
  return {
    useUser: vi.fn(() => {
      return { user: null, isLoaded: true };
    }),
    useClerk: vi.fn(() => {
      return { signOut: vi.fn() };
    }),
  };
});

// External: next/navigation (used by BlogContent, notFound)
vi.mock("next/navigation", () => {
  return {
    notFound: vi.fn(),
    useSearchParams: vi.fn(() => {
      return new URLSearchParams();
    }),
    useParams: vi.fn(() => {
      return {};
    }),
    useRouter: vi.fn(() => {
      return {};
    }),
  };
});

import { generateMetadata } from "../page";

describe("blog post page metadata", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://test.vm0.ai");
    vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://test-strapi.example.com");
    reloadEnv();

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
      searchParams: Promise.resolve({}),
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://www.vm0.ai/en/blog/posts/test-post",
    );
  });

  it("uses locale in canonical URL", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "test-post", locale: "ja" }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://www.vm0.ai/ja/blog/posts/test-post",
    );
  });

  it("returns no canonical URL when post does not exist", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "non-existent", locale: "en" }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.title).toBe("Post Not Found");
    expect(metadata.alternates).toBeUndefined();
  });
});
