import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const clerkState = vi.hoisted(() => {
  return {
    protectedPaths: [] as string[],
  };
});

type ClerkHandler = (
  auth: { protect: () => Promise<void> },
  request: NextRequest,
) => Promise<NextResponse | undefined>;

function routePatternToRegex(pattern: string): RegExp {
  const WILDCARD_PLACEHOLDER = "\x00WILDCARD\x00";
  const escaped = pattern
    .replaceAll("(.*)", WILDCARD_PLACEHOLDER)
    .replace(/[.+?^${}[\]|\\]/g, "\\$&")
    .replace(/\/:[^/]+/g, "/[^/]+")
    .replaceAll(WILDCARD_PLACEHOLDER, ".*");

  return new RegExp(`^${escaped}$`);
}

vi.mock("@clerk/nextjs/server", () => {
  return {
    clerkMiddleware: vi.fn((handler: ClerkHandler) => {
      return vi.fn(async (request: NextRequest) => {
        const auth = {
          protect: async () => {
            clerkState.protectedPaths.push(request.nextUrl.pathname);
          },
        };
        const result = await handler(auth, request);
        return result ?? NextResponse.next();
      });
    }),
    createRouteMatcher: vi.fn((patterns: string[]) => {
      const regexes = patterns.map(routePatternToRegex);
      return (request: NextRequest) => {
        return regexes.some((regex) => {
          return regex.test(request.nextUrl.pathname);
        });
      };
    }),
  };
});

vi.mock("next-intl/middleware", () => {
  return {
    default: () => {
      return () => {
        return NextResponse.next();
      };
    },
  };
});

let middleware: typeof import("../proxy").default;
let reloadEnv: typeof import("../src/env").reloadEnv;

function createMockEvent() {
  return {
    sourcePage: "/test",
    waitUntil: vi.fn(),
  } as never;
}

describe("proxy middleware: public routes", () => {
  beforeAll(async () => {
    middleware = (await import("../proxy")).default;
    reloadEnv = (await import("../src/env")).reloadEnv;
  });

  beforeEach(() => {
    clerkState.protectedPaths = [];
    vi.unstubAllEnvs();
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_proxy");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_proxy");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.vm0.ai");
    reloadEnv();
  });

  it("keeps locale-prefixed web design gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/web-design");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("rejects non-GET requests for so frontend rewrite pages when forwarding is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const request = new NextRequest("https://www.vm0.ai/en/pricing", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("allows non-GET requests through when so frontend forwarding is disabled", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/pricing", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(response.status).not.toBe(405);
  });

  it("does not reject app-only functional routes when so forwarding is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const request = new NextRequest("https://www.vm0.ai/connector/success", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(response.status).not.toBe(405);
  });

  it("keeps locale-less web design gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/web-design");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed presentation gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/presentation");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less presentation gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/presentation");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed report gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/report");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less report gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/report");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed sprite gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/sprite");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less sprite gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/sprite");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed showcase public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/showcase");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed illustration gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/illustration");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less illustration gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/illustration");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed docs index public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/docs");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-prefixed docs sub-pages public", async () => {
    const request = new NextRequest(
      "https://www.vm0.ai/en/docs/getting-started/install",
    );

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("still protects non-public page routes", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/lab");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual(["/en/lab"]);
  });
});
