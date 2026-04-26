import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { honoComputed } from "../context/route";
import { clerkSessionAuth$ } from "./clerk-session";

const clerkClient = vi.hoisted(() => {
  return {
    authenticateRequest: vi.fn(),
  };
});

vi.mock("@clerk/backend", () => {
  return {
    createClerkClient: () => {
      return clerkClient;
    },
  };
});

function createAuthApp(): Hono {
  const app = new Hono();
  app.get("/", honoComputed(clerkSessionAuth$, new AbortController().signal));
  return app;
}

describe("clerkSessionAuth$", () => {
  beforeEach(() => {
    clerkClient.authenticateRequest.mockReset();
  });

  it("projects authenticated Clerk sessions into API auth context", async () => {
    clerkClient.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: "user_123",
          orgId: "org_123",
          orgRole: "org:admin",
        };
      },
    });

    const response = await createAuthApp().request("/", {
      headers: { authorization: "Bearer clerk-session" },
    });
    const payload: unknown = await response.json();

    expect(payload).toEqual({
      tokenType: "session",
      userId: "user_123",
      orgId: "org_123",
      orgRole: "admin",
    });
    expect(clerkClient.authenticateRequest).toHaveBeenCalledTimes(1);
    expect(clerkClient.authenticateRequest.mock.calls[0]?.[0]).toBeInstanceOf(
      Request,
    );
    expect(clerkClient.authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: "session_token",
    });
  });

  it("returns null for unauthenticated requests", async () => {
    clerkClient.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await createAuthApp().request("/");
    const payload: unknown = await response.json();

    expect(payload).toBeNull();
  });
});
