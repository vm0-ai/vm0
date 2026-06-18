import type { AnchorHTMLAttributes, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../../src/mocks/server";
import { ThemeProvider } from "../../../components/ThemeProvider";
import RankingsPage from "../page";

vi.mock("next-intl/server", () => {
  return {
    getTranslations: vi.fn(async () => {
      return (key: string) => {
        return `rankings.${key}`;
      };
    }),
    getRequestConfig: vi.fn((fn: unknown) => {
      return fn;
    }),
  };
});

vi.mock("next-intl", () => {
  return {
    useTranslations: vi.fn(() => {
      return (key: string) => {
        return `footer.${key}`;
      };
    }),
    useLocale: vi.fn(() => {
      return "en";
    }),
  };
});

vi.mock("next-intl/navigation", () => {
  return {
    createNavigation: vi.fn(() => {
      return {
        Link: ({
          href,
          children,
          ...props
        }: {
          href: string;
          children: ReactNode;
        } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
          return (
            <a href={href} {...props}>
              {children}
            </a>
          );
        },
        redirect: vi.fn(),
        usePathname: vi.fn(() => {
          return "/en/rankings";
        }),
        useRouter: vi.fn(() => {
          return { push: vi.fn() };
        }),
      };
    }),
  };
});

vi.mock("next/link", () => {
  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children: ReactNode;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    },
  };
});

vi.mock("next/image", () => {
  return {
    default: ({ alt, src }: { alt: string; src: string }) => {
      return <span data-alt={alt} data-src={src} />;
    },
  };
});

function mockRankingsApi() {
  server.use(
    http.get(
      "http://localhost:3001/api/public/model-rankings",
      ({ request }) => {
        const period = new URL(request.url).searchParams.get("period");
        return HttpResponse.json({
          period,
          totalTokens: 150,
          windowStart: "2026-06-01T00:00:00.000Z",
          windowEnd: "2026-06-18T03:00:00.000Z",
          rows: [
            {
              model: "gpt-5.5",
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              previousTotalTokens: 75,
            },
          ],
        });
      },
    ),
  );
}

async function renderRankings(view: "week" | "month"): Promise<string> {
  const page = await RankingsPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: Promise.resolve({ view }),
  });
  return renderToStaticMarkup(<ThemeProvider>{page}</ThemeProvider>);
}

function tableHeaderCount(html: string): number {
  return html.match(/<th\b/g)?.length ?? 0;
}

describe("rankings page", () => {
  it("hides the change column only for monthly rankings", async () => {
    mockRankingsApi();

    const monthHtml = await renderRankings("month");
    const weekHtml = await renderRankings("week");

    expect(tableHeaderCount(monthHtml)).toBe(4);
    expect(tableHeaderCount(weekHtml)).toBe(5);
  });
});
