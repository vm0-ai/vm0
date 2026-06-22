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
    vi.unstubAllGlobals();
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

  it("proxies non-GET requests for so frontend rewrite pages when forwarding is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("proxied", {
        status: 202,
        headers: {
          "x-so-frontend": "1",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("https://www.vm0.ai/en?from=signout", {
      method: "POST",
      headers: {
        connection: "keep-alive",
        "content-type": "text/plain;charset=UTF-8",
        cookie: "__session=test",
        origin: "https://www.vm0.ai",
        referer: "https://www.vm0.ai/en?from=signout",
      },
      body: "payload",
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [targetUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(targetUrl)).toBe("https://so.vm0.ai/en?from=signout");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init as RequestInit & { duplex?: string })?.duplex).toBe("half");
    const proxiedHeaders = init?.headers as Headers;
    expect(proxiedHeaders.get("connection")).toBeNull();
    expect(proxiedHeaders.get("content-length")).toBeNull();
    expect(proxiedHeaders.get("origin")).toBe("https://so.vm0.ai");
    expect(proxiedHeaders.get("referer")).toBe(
      "https://so.vm0.ai/en?from=signout",
    );
    expect(proxiedHeaders.get("x-forwarded-host")).toBe("www.vm0.ai");
    expect(proxiedHeaders.get("x-forwarded-proto")).toBe("https");
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected proxy response");
    }
    expect(response.status).toBe(202);
    expect(response.headers.get("x-so-frontend")).toBe("1");
    await expect(response.text()).resolves.toBe("proxied");
    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("proxies bodyless so frontend POST requests without a request body stream", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
      headers: {
        origin: "https://www.vm0.ai",
        referer: "https://www.vm0.ai/en",
      },
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    if (!init) {
      throw new Error("Expected fetch init");
    }
    expect("body" in init).toBe(false);
    expect((init as RequestInit & { duplex?: string }).duplex).toBeUndefined();
    const proxiedHeaders = init.headers as Headers;
    expect(proxiedHeaders.get("origin")).toBe("https://so.vm0.ai");
    expect(proxiedHeaders.get("referer")).toBe("https://so.vm0.ai/en");
    expect(response?.status).toBe(202);
  });

  it("does not proxy non-GET requests when so frontend forwarding is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected middleware response");
    }
    expect(response.status).not.toBe(202);
  });

  it("proxies auth routes to so in preview", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://staging-so.vm6.ai");
    vi.stubEnv("VERCEL_ENV", "preview");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("preview auth proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest(
      "https://pr-18518-www.vm6.ai/sign-in/factor-one",
      {
        method: "POST",
      },
    );

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [targetUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(targetUrl)).toBe(
      "https://staging-so.vm6.ai/sign-in/factor-one",
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected preview auth proxy response");
    }
    expect(response.status).toBe(202);
  });

  it("proxies auth routes to so in production", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("auth proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest("https://www.vm0.ai/sign-in/factor-one", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [targetUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(targetUrl)).toBe("https://so.vm0.ai/sign-in/factor-one");
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected auth proxy response");
    }
    expect(response.status).toBe(202);
  });

  it("does not proxy app-only functional routes when so forwarding is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest("https://www.vm0.ai/connector/success", {
      method: "POST",
    });

    await middleware(request, createMockEvent());

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("keeps locale-prefixed video gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/video");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less video gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/video");

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
