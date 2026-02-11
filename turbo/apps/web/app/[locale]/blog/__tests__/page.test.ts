import { describe, it, expect, vi, beforeEach } from "vitest";
import { reloadEnv } from "../../../../src/env";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://test.vm0.ai");
  vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://test-strapi.example.com");
  reloadEnv();
});

// External: next-intl/server (used by page.tsx and i18n.ts)
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `mock-${key}`),
  getRequestConfig: vi.fn((fn: unknown) => fn),
}));

// External: next-intl/navigation (used by navigation.ts)
vi.mock("next-intl/navigation", () => ({
  createNavigation: vi.fn(() => ({
    Link: () => null,
    redirect: vi.fn(),
    usePathname: vi.fn(),
    useRouter: vi.fn(),
  })),
}));

// External: next-intl (used by Navbar, Footer, BlogContent, ShareButtons)
vi.mock("next-intl", () => ({
  useTranslations: vi.fn(() => (key: string) => `mock-${key}`),
}));

// External: @clerk/nextjs (used by Navbar)
vi.mock("@clerk/nextjs", () => ({
  useUser: vi.fn(() => ({ user: null, isLoaded: true })),
  useClerk: vi.fn(() => ({ signOut: vi.fn() })),
}));

// External: next/navigation (used by BlogContent)
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  useRouter: vi.fn(() => ({})),
}));

import { generateMetadata } from "../page";

describe("blog list page metadata", () => {
  it("includes canonical URL with locale", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en" }),
    });

    expect(metadata.alternates?.canonical).toBe("https://test.vm0.ai/en/blog");
  });

  it("constructs canonical URL for non-English locale", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "ja" }),
    });

    expect(metadata.alternates?.canonical).toBe("https://test.vm0.ai/ja/blog");
  });
});
