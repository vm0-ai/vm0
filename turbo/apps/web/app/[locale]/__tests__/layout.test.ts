import { describe, it, expect, vi } from "vitest";

// External: next/navigation
vi.mock("next/navigation", () => {
  return {
    notFound: vi.fn(),
  };
});

// External: next-intl
vi.mock("next-intl", () => {
  return {
    NextIntlClientProvider: ({ children }: { children: unknown }) => {
      return children;
    },
  };
});

// External: next-intl/navigation
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

// External: next-intl/server (used by i18n.ts)
vi.mock("next-intl/server", () => {
  return {
    getRequestConfig: vi.fn((fn: unknown) => {
      return fn;
    }),
  };
});

import { generateMetadata } from "../layout";

describe("locale layout generateMetadata", () => {
  it("returns metadata with openGraph for valid locale", async () => {
    const metadata = await generateMetadata({
      children: null,
      params: Promise.resolve({ locale: "en" }),
    });

    expect(metadata.openGraph?.url).toBe("https://www.vm0.ai/en");
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.twitter).toBeDefined();
  });

  it("returns metadata for each supported locale", async () => {
    for (const locale of ["en", "de", "ja", "es"]) {
      const metadata = await generateMetadata({
        children: null,
        params: Promise.resolve({ locale }),
      });

      expect(metadata.openGraph?.url).toBe(`https://www.vm0.ai/${locale}`);
    }
  });

  it("returns empty metadata for invalid locale with dot", async () => {
    const metadata = await generateMetadata({
      children: null,
      params: Promise.resolve({ locale: "apple-touch-icon.png" }),
    });

    expect(metadata).toEqual({});
  });

  it("returns empty metadata for invalid locale without dot", async () => {
    const metadata = await generateMetadata({
      children: null,
      params: Promise.resolve({ locale: "swagger" }),
    });

    expect(metadata).toEqual({});
  });

  it("returns empty metadata for openapi.json locale", async () => {
    const metadata = await generateMetadata({
      children: null,
      params: Promise.resolve({ locale: "openapi.json" }),
    });

    expect(metadata).toEqual({});
  });
});
