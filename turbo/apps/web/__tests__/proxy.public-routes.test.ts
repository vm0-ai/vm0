import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { brotliCompressSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { HttpResponse, http } from "msw";
import { server } from "../src/mocks/server";

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

interface ForwardedRequest {
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function captureForwardedRequests(
  method: "post",
  url: string,
  response: Response,
): ForwardedRequest[] {
  const requests: ForwardedRequest[] = [];
  server.use(
    http[method](url, ({ request }) => {
      requests.push({
        headers: request.headers,
        method: request.method,
        url: request.url,
      });
      return response;
    }),
  );
  return requests;
}

function compressedComponentResponse(body: string, status: number): Response {
  const encodedBody = brotliCompressSync(Buffer.from(body));
  return new HttpResponse(encodedBody, {
    status,
    headers: {
      "content-encoding": "br",
      "content-length": String(encodedBody.byteLength),
      "content-type": "text/x-component",
    },
  });
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
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/en",
      new HttpResponse("proxied", {
        status: 202,
        headers: {
          "x-so-frontend": "1",
        },
      }),
    );

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

    expect(forwardedRequests).toHaveLength(1);
    const [forwardedRequest] = forwardedRequests;
    if (!forwardedRequest) {
      throw new Error("Expected forwarded request");
    }
    expect(forwardedRequest.url).toBe("https://so.vm0.ai/en?from=signout");
    expect(forwardedRequest.method).toBe("POST");
    expect(forwardedRequest.headers).toBeInstanceOf(Headers);
    const proxiedHeaders = forwardedRequest.headers;
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

  it("uses the SO origin as forwarded host for SO frontend server actions", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
      headers: {
        "next-action": "abc123",
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
    const proxiedHeaders = init.headers as Headers;
    expect(proxiedHeaders.get("origin")).toBe("https://so.vm0.ai");
    expect(proxiedHeaders.get("referer")).toBe("https://so.vm0.ai/en");
    expect(proxiedHeaders.get("x-forwarded-host")).toBe("so.vm0.ai");
    expect(proxiedHeaders.get("x-forwarded-proto")).toBe("https");
    expect(response?.status).toBe(202);
  });

  it("uses the final staging SO origin for local SO alias server actions", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm7.ai:8443");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("http://localhost:3000/en", {
      method: "POST",
      headers: {
        "next-action": "abc123",
        origin: "https://www.vm7.ai:8443",
        referer: "https://www.vm7.ai:8443/en",
        "x-forwarded-host": "www.vm7.ai:8443",
        "x-forwarded-proto": "https",
      },
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    if (!init) {
      throw new Error("Expected fetch init");
    }
    const proxiedHeaders = init.headers as Headers;
    expect(proxiedHeaders.get("origin")).toBe("https://staging-so.vm6.ai");
    expect(proxiedHeaders.get("referer")).toBe("https://staging-so.vm6.ai/en");
    expect(proxiedHeaders.get("x-forwarded-host")).toBe("staging-so.vm6.ai");
    expect(proxiedHeaders.get("x-forwarded-proto")).toBe("https");
    expect(response?.status).toBe(202);
  });

  it("treats SO frontend form POSTs as server actions", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("proxied", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=boundary",
        origin: "https://www.vm0.ai",
        referer: "https://www.vm0.ai/en",
      },
      body: "--boundary--",
    });

    const response = await middleware(request, createMockEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    if (!init) {
      throw new Error("Expected fetch init");
    }
    const proxiedHeaders = init.headers as Headers;
    expect(proxiedHeaders.get("origin")).toBe("https://so.vm0.ai");
    expect(proxiedHeaders.get("referer")).toBe("https://so.vm0.ai/en");
    expect(proxiedHeaders.get("x-forwarded-host")).toBe("so.vm0.ai");
    expect(proxiedHeaders.get("x-forwarded-proto")).toBe("https");
    expect(response?.status).toBe(202);
  });

  it("does not proxy non-GET requests when so frontend forwarding is disabled", async () => {
    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

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
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://staging-so.vm6.ai/sign-in/factor-one",
      new HttpResponse("preview auth proxied", { status: 202 }),
    );
    const request = new NextRequest(
      "https://pr-18518-www.vm6.ai/sign-in/factor-one",
      {
        method: "POST",
      },
    );

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0]?.url).toBe(
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
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/sign-in/factor-one",
      new HttpResponse("auth proxied", { status: 202 }),
    );
    const request = new NextRequest("https://www.vm0.ai/sign-in/factor-one", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0]?.url).toBe(
      "https://so.vm0.ai/sign-in/factor-one",
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected auth proxy response");
    }
    expect(response.status).toBe(202);
  });

  it("proxies sign-up verification routes to so while preserving redirect_url", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/sign-up/verify-email-address",
      new HttpResponse("verification proxied", { status: 202 }),
    );

    const request = new NextRequest(
      "https://www.vm0.ai/sign-up/verify-email-address?redirect_url=https%3A%2F%2Fapp.vm0.ai%2Fagents%2F4f189ea8-ada2-416d-83a9-9c25ddb960c9%2Fchat",
      {
        method: "POST",
      },
    );

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    expect(forwardedRequests[0]?.url).toBe(
      "https://so.vm0.ai/sign-up/verify-email-address?redirect_url=https%3A%2F%2Fapp.vm0.ai%2Fagents%2F4f189ea8-ada2-416d-83a9-9c25ddb960c9%2Fchat",
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected verification proxy response");
    }
    expect(response.status).toBe(202);
  });

  it("normalizes compression headers for proxied sign-up verification responses", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/sign-up/verify-email-address",
      compressedComponentResponse("verification proxied", 202),
    );

    const request = new NextRequest(
      "https://www.vm0.ai/sign-up/verify-email-address?redirect_url=https%3A%2F%2Fapp.vm0.ai%2Fagents%2F4f189ea8-ada2-416d-83a9-9c25ddb960c9%2Fchat",
      {
        method: "POST",
        headers: {
          "accept-encoding": "gzip, deflate, br, zstd",
        },
      },
    );

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    const [forwardedRequest] = forwardedRequests;
    if (!forwardedRequest) {
      throw new Error("Expected forwarded verification request");
    }
    expect(forwardedRequest.url).toBe(
      "https://so.vm0.ai/sign-up/verify-email-address?redirect_url=https%3A%2F%2Fapp.vm0.ai%2Fagents%2F4f189ea8-ada2-416d-83a9-9c25ddb960c9%2Fchat",
    );
    expect(forwardedRequest.headers.get("accept-encoding")).toBe("identity");
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected verification proxy response");
    }
    expect(response.status).toBe(202);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/x-component");
    await expect(response.text()).resolves.toBe("verification proxied");
  });

  it("normalizes compression headers for proxied locale page action responses", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/en",
      compressedComponentResponse("locale action proxied", 200),
    );

    const request = new NextRequest("https://www.vm0.ai/en", {
      method: "POST",
      headers: {
        "accept-encoding": "gzip, deflate, br, zstd",
      },
    });

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    const [forwardedRequest] = forwardedRequests;
    if (!forwardedRequest) {
      throw new Error("Expected forwarded locale page request");
    }
    expect(forwardedRequest.url).toBe("https://so.vm0.ai/en");
    expect(forwardedRequest.headers.get("accept-encoding")).toBe("identity");
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected locale page proxy response");
    }
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/x-component");
    await expect(response.text()).resolves.toBe("locale action proxied");
  });

  it("proxies migrated functional routes when so forwarding is enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAID_ONBOARDING_URL", "https://so.vm0.ai");
    reloadEnv();
    const forwardedRequests = captureForwardedRequests(
      "post",
      "https://so.vm0.ai/connector/success",
      new HttpResponse("functional route proxied", { status: 202 }),
    );
    const request = new NextRequest("https://www.vm0.ai/connector/success", {
      method: "POST",
    });

    const response = await middleware(request, createMockEvent());

    expect(forwardedRequests).toHaveLength(1);
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected functional route proxy response");
    }
    expect(response.status).toBe(202);
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
