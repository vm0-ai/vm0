import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../../../components/ThemeProvider";
import UseCasesGalleryClient from "../UseCasesGalleryClient";
import { USE_CASES, buildTryItHref } from "../data";

// External: next-intl/navigation (used by ../../../navigation -> Link)
vi.mock("next-intl/navigation", () => {
  return {
    createNavigation: vi.fn(() => {
      return {
        Link: ({
          href,
          children,
          className,
        }: {
          href: string;
          children: React.ReactNode;
          className?: string;
        }) => {
          return (
            <a href={href} className={className}>
              {children}
            </a>
          );
        },
        redirect: vi.fn(),
        usePathname: vi.fn(() => {
          return "/";
        }),
        useRouter: vi.fn(() => {
          return { push: vi.fn() };
        }),
      };
    }),
  };
});

// External: next-intl
vi.mock("next-intl", () => {
  return {
    useTranslations: vi.fn(() => {
      return (key: string) => {
        return key;
      };
    }),
    useLocale: vi.fn(() => {
      return "en";
    }),
  };
});

// External: next/link
vi.mock("next/link", () => {
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children: React.ReactNode;
      className?: string;
    }) => {
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    },
  };
});

// External: next/image
vi.mock("next/image", () => {
  return {
    default: ({ alt, src }: { alt: string; src: string }) => {
      return <span data-alt={alt} data-src={src} />;
    },
  };
});

// External: platform URL comes from validated env — stub it to keep the test hermetic.
vi.mock("../../../../src/lib/zero/url", () => {
  return {
    getAppUrl: () => {
      return "https://app.example.com";
    },
  };
});

describe("UseCasesGalleryClient try-it CTA", () => {
  it("renders a try-it CTA for every use case, each pointing at the platform with connector ids", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <UseCasesGalleryClient />
      </ThemeProvider>,
    );

    // One CTA per use case — the "More to come" tile uses a mailto link, not tryItButton.
    const ctaMatches = html.match(/class="uc-try-it-cta[^"]*"/g) ?? [];
    expect(ctaMatches).toHaveLength(USE_CASES.length);

    // Every use case's computed href appears in the rendered markup.
    for (const uc of USE_CASES) {
      const href = buildTryItHref(uc, "https://app.example.com");
      // Hrefs get HTML-escaped (& -> &amp;), so compare against the escaped form.
      const escaped = href.replace(/&/g, "&amp;");
      expect(html).toContain(escaped);
    }
  });
});
