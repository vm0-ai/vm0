import { unstable_doesMiddlewareMatch } from "next/dist/experimental/testing/server/middleware-testing-utils";
import { describe, expect, it, vi } from "vitest";
import { config } from "../proxy";

vi.mock("next-intl/middleware", () => {
  return {
    default: () => {
      return () => {
        return null;
      };
    },
  };
});

function expectProxyMatch(url: string, expected: boolean): void {
  expect(unstable_doesMiddlewareMatch({ config, url })).toBe(expected);
}

describe("proxy matcher", () => {
  it("matches locale-prefixed docs routes with markdown-like suffixes", () => {
    expectProxyMatch("/en/docs/quickstart.md", true);
    expectProxyMatch("/de/docs/schedules.md", true);
    expectProxyMatch("/ja/docs/what-zero-delivers/examples.md", true);
    expectProxyMatch("/es/docs/a.b/c.md", true);
  });

  it("keeps canonical docs routes matched", () => {
    expectProxyMatch("/en/docs", true);
    expectProxyMatch("/en/docs/quickstart", true);
  });

  it("does not broaden matching for unsupported locale docs paths", () => {
    expectProxyMatch("/foo/docs/quickstart.md", false);
    expectProxyMatch("/docs/quickstart.md", false);
  });

  it("keeps static asset paths excluded from proxy", () => {
    expectProxyMatch("/apple-touch-icon.png", false);
    expectProxyMatch("/_next/static/chunks/app.js", false);
    expectProxyMatch("/_next/image?url=%2Fog-image.png", false);
    expectProxyMatch("/assets/vm0-logo.svg", false);
  });

  it("continues to match API and RPC routes", () => {
    expectProxyMatch("/api/test.json", true);
    expectProxyMatch("/v1/chat/completions", true);
    expectProxyMatch("/trpc/foo.bar", true);
  });
});
