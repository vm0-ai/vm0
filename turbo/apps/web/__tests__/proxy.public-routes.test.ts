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
  const escaped = pattern
    .replace(/[.+?^${}[\]|\\]/g, "\\$&")
    .replace(/\/:[^/]+/g, "/[^/]+")
    .replace(/\\\(\\.\\\*\\\)/g, ".*");

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

function createMockEvent() {
  return {
    sourcePage: "/test",
    waitUntil: vi.fn(),
  } as never;
}

describe("proxy middleware: public routes", () => {
  beforeAll(async () => {
    middleware = (await import("../proxy")).default;
  });

  beforeEach(() => {
    clerkState.protectedPaths = [];
  });

  it("keeps locale-prefixed gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/gallery");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("keeps locale-less gallery public", async () => {
    const request = new NextRequest("https://www.vm0.ai/gallery");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual([]);
  });

  it("still protects non-public page routes", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/lab");

    await middleware(request, createMockEvent());

    expect(clerkState.protectedPaths).toEqual(["/en/lab"]);
  });
});
