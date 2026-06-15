import { describe, it, expect, vi, beforeEach } from "vitest";
import { reloadEnv } from "../../../../src/env";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://test.vm0.ai");
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://test-strapi.example.com");
  reloadEnv();
});

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

// External: next-intl/navigation (used by navigation.ts)
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

// External: next-intl (used by Navbar, Footer, BlogContent, ShareButtons)
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

// External: next/navigation (used by BlogContent)
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

describe("blog list page metadata", () => {
  it("includes canonical URL with locale", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en" }),
    });

    expect(metadata.alternates?.canonical).toBe("https://www.vm0.ai/en/blog");
    expect(metadata.alternates?.languages).toMatchObject({
      en: "https://www.vm0.ai/en/blog",
      de: "https://www.vm0.ai/de/blog",
      ja: "https://www.vm0.ai/ja/blog",
      es: "https://www.vm0.ai/es/blog",
    });
  });

  it("constructs canonical URL for non-English locale", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "ja" }),
    });

    expect(metadata.alternates?.canonical).toBe("https://www.vm0.ai/ja/blog");
  });
});
