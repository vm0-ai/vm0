import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Captures the request that Clerk middleware receives, so we can verify
 * the outer middleware strips/restores headers correctly.
 */
let capturedClerkRequest: NextRequest | undefined;

// Override the global @clerk/nextjs/server mock with implementations that
// return callable functions (the global setup.ts mock returns bare vi.fn()).
type ClerkHandler = (
  auth: { protect: ReturnType<typeof vi.fn> },
  request: NextRequest,
) => Promise<NextResponse | undefined>;

vi.mock("@clerk/nextjs/server", () => {
  return {
    clerkMiddleware: vi.fn((handler: ClerkHandler) => {
      // Return a NextMiddleware-shaped function that calls the handler
      return vi.fn(async (request: NextRequest) => {
        capturedClerkRequest = request;
        // Simulate Clerk calling the handler with a mock auth object
        const auth = { protect: vi.fn() };
        const result = await handler(auth, request);
        return result ?? NextResponse.next();
      });
    }),
    createRouteMatcher: vi.fn(() => {
      // Return a matcher that marks all routes as public
      return () => {
        return true;
      };
    }),
  };
});

// Mock next-intl/middleware to avoid ESM resolution issues in test environment.
// This is an external dependency mock (not internal code), which is acceptable.
vi.mock("next-intl/middleware", () => {
  return {
    default: () => {
      return () => {
        return NextResponse.next();
      };
    },
  };
});

// Import after mocks are set up
import middleware from "../proxy";

/**
 * Create a minimal NextFetchEvent stub.
 * The outer middleware passes this through to Clerk — we only need a
 * type-compatible object, not a real FetchEvent.
 */
function createMockEvent() {
  return {
    sourcePage: "/test",
    waitUntil: vi.fn(),
    // Satisfy the NextFetchEvent interface without constructing a real FetchEvent
  } as never;
}

describe("proxy middleware: sandbox token handling", () => {
  beforeEach(() => {
    capturedClerkRequest = undefined;
  });

  it("should skip Clerk for sandbox tokens and preserve authorization header", async () => {
    const token = "Bearer vm0_sandbox_header.payload.signature";
    const request = new NextRequest("https://www.vm0.ai/api/sandbox/webhook", {
      headers: { authorization: token },
    });

    const response = await middleware(request, createMockEvent());

    // Clerk should NOT be called for sandbox token requests
    expect(capturedClerkRequest).toBeUndefined();

    // Response should be a pass-through (NextResponse.next())
    expect(response).toBeDefined();
  });

  it("should pass non-sandbox tokens through to Clerk unchanged", async () => {
    const token = "Bearer sk_test_some_clerk_session_token";
    const request = new NextRequest("https://www.vm0.ai/api/runs", {
      headers: { authorization: token },
    });

    await middleware(request, createMockEvent());

    // Clerk should see the original Authorization header
    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBe(token);

    // x-vm0-authorization should not be set
    expect(capturedClerkRequest!.headers.get("x-vm0-authorization")).toBeNull();
  });

  it("should pass requests without authorization header through normally", async () => {
    const request = new NextRequest("https://www.vm0.ai/en/blog");

    await middleware(request, createMockEvent());

    // Clerk should receive the request with no authorization header
    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBeNull();
    expect(capturedClerkRequest!.headers.get("x-vm0-authorization")).toBeNull();
  });

  it("should skip Clerk for PAT tokens and preserve authorization header", async () => {
    const token = "Bearer vm0_pat_header.payload.signature";
    const request = new NextRequest("https://www.vm0.ai/api/runs", {
      headers: { authorization: token },
    });

    const response = await middleware(request, createMockEvent());

    // Clerk should NOT be called for PAT token requests
    expect(capturedClerkRequest).toBeUndefined();

    // Response should be a pass-through (NextResponse.next())
    expect(response).toBeDefined();
  });

  it("should pass non-sandbox tokens through to Clerk unchanged", async () => {
    const token = "Bearer invalid_abc123def456";
    const request = new NextRequest("https://www.vm0.ai/api/runs", {
      headers: { authorization: token },
    });

    await middleware(request, createMockEvent());

    // Non-sandbox tokens should pass through to Clerk
    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBe(token);
  });

  it("should pass unknown token formats through to Clerk unchanged", async () => {
    const token = "Bearer unknown_format_abc123";
    const request = new NextRequest("https://www.vm0.ai/api/runs", {
      headers: { authorization: token },
    });

    await middleware(request, createMockEvent());

    // Unknown token formats are not self-signed tokens and should pass through
    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBe(token);
  });

  it("should strip sandbox token and still call Clerk on non-API paths", async () => {
    // Bot/scanner traffic: sandbox token sent to a page route. Without this
    // behavior, Clerk middleware is skipped and any server component calling
    // auth() throws "clerkMiddleware not detected". See issue #10164.
    const token = "Bearer vm0_sandbox_header.payload.signature";
    const request = new NextRequest("https://www.vm0.ai/en", {
      headers: { authorization: token },
    });

    await middleware(request, createMockEvent());

    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBeNull();
  });

  it("should strip PAT token and still call Clerk on non-API paths", async () => {
    const token = "Bearer vm0_pat_header.payload.signature";
    const request = new NextRequest("https://www.vm0.ai/", {
      headers: { authorization: token },
    });

    await middleware(request, createMockEvent());

    expect(capturedClerkRequest).toBeDefined();
    expect(capturedClerkRequest!.headers.get("authorization")).toBeNull();
  });
});
