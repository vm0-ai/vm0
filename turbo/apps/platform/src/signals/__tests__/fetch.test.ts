/**
 * Tests for the fetch$ wrapper itself (401 redirect, token refresh, retry).
 *
 * mockApi cannot be used in this file: the wrapper is exercised against
 * synthetic URLs (`/test`, `/api/zero/items`) that do not correspond to any
 * ts-rest contract — they exist solely to drive the wrapper's status-code and
 * retry logic. Migrating them would require inventing contracts for paths
 * that have no server-side implementation, so the `http.*` usage here is
 * intentional and should remain exempt from the Phase 3 capstone rule (#10091).
 */
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { fetch$ } from "../fetch.ts";
import { testContext } from "./test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";

const context = testContext();

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function createCaptureHandler(
  method: "get" | "post" | "put" | "delete",
  urlPattern: string,
  captured: { request: CapturedRequest | null },
) {
  const handler = http[method](urlPattern, async ({ request }) => {
    const headers: Record<string, string> = {};
    // Normalize header keys to lowercase for consistent access
    for (const [key, value] of request.headers.entries()) {
      headers[key.toLowerCase()] = value;
    }

    captured.request = {
      url: request.url,
      method: request.method,
      headers,
      body: request.body ? await request.text() : null,
    };

    return new Response(null, { status: 200 });
  });
  return handler;
}

describe("fetch$ signal integration tests", () => {
  it("should handle Headers object", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);
    const inputHeaders = new Headers({
      "Content-Type": "application/json",
      "X-Custom": "custom-value",
    });

    await fch("/test", {
      headers: inputHeaders,
    });

    expect(captured.request).not.toBeNull();
    expect(captured.request?.headers["content-type"]).toBe("application/json");
    expect(captured.request?.headers["x-custom"]).toBe("custom-value");
  });

  it("should add Authorization header when session token exists", async () => {
    const mockToken = "test-jwt-token";

    detachedSetupPage({
      context,
      path: "/",
      session: { token: mockToken },
      withoutRender: true,
    });

    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);
    await fch("/test");

    expect(captured.request).not.toBeNull();
    expect(captured.request?.headers["authorization"]).toBe(
      `Bearer ${mockToken}`,
    );
  });

  it("should not add Authorization header when no session", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);
    await fch("/test");

    expect(captured.request).not.toBeNull();
    // When no session, the token is empty string, so no Authorization header or empty
    expect(
      captured.request?.headers["authorization"] === undefined ||
        captured.request?.headers["authorization"] === "Bearer ",
    ).toBeTruthy();
  });

  it("should handle both Authorization and custom headers", async () => {
    const mockToken = "test-jwt-token";

    detachedSetupPage({
      context,
      path: "/",
      session: { token: mockToken },
      withoutRender: true,
    });

    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);
    const inputHeaders = {
      "Content-Type": "application/json",
      "X-Custom": "custom-value",
    };

    await fch("/test", {
      headers: inputHeaders,
    });

    expect(captured.request).not.toBeNull();
    expect(captured.request?.headers["authorization"]).toBe(
      `Bearer ${mockToken}`,
    );
    expect(captured.request?.headers["content-type"]).toBe("application/json");
    expect(captured.request?.headers["x-custom"]).toBe("custom-value");
  });

  it("should allow user-provided Authorization to override automatic one", async () => {
    const mockToken = "test-jwt-token";

    detachedSetupPage({
      context,
      path: "/",
      session: { token: mockToken },
      withoutRender: true,
    });

    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);
    const customToken = "custom-override-token";

    await fch("/test", {
      headers: {
        Authorization: `Bearer ${customToken}`,
      },
    });

    expect(captured.request).not.toBeNull();
    expect(captured.request?.headers["authorization"]).toBe(
      `Bearer ${customToken}`,
    );
  });
});

describe("url handling", () => {
  it("should prepend apiBase to relative paths", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/users", captured),
    );

    const fch = context.store.get(fetch$);
    await fch("/users");

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe("http://localhost:3000/users");
  });

  it("should prepend apiBase to paths without leading slash", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("get", "http://localhost:3000/users", captured),
    );

    const fch = context.store.get(fetch$);
    await fch("users");

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe("http://localhost:3000/users");
  });

  it("should keep absolute URLs unchanged", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };
    const absoluteUrl = "https://external-api.com/data";

    server.use(createCaptureHandler("get", absoluteUrl, captured));

    const fch = context.store.get(fetch$);
    await fch(absoluteUrl);

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe(absoluteUrl);
  });

  it("should handle query parameters", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler(
        "get",
        "http://localhost:3000/api/zero/users",
        captured,
      ),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/users?page=1&size=10");

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe(
      "http://localhost:3000/api/zero/users?page=1&size=10",
    );
  });
});

describe("401 redirect", () => {
  it("should redirect to sign-in when API returns 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    server.use(
      http.get("http://localhost:3000/test", () => {
        return HttpResponse.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    const fch = context.store.get(fetch$);
    const response = await fch("/test");

    expect(response.status).toBe(401);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("should not redirect on non-401 errors", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    server.use(
      http.get("http://localhost:3000/test", () => {
        return HttpResponse.json(
          { error: { message: "Forbidden", code: "FORBIDDEN" } },
          { status: 403 },
        );
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    const fch = context.store.get(fetch$);
    await fch("/test");

    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });
});

describe("401 refresh-and-retry", () => {
  it("should refresh the token and retry once when API returns 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      http.get("http://localhost:3000/test", ({ request }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        if (authHeaders.length === 1) {
          return HttpResponse.json(
            { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }
        return HttpResponse.json({ ok: true }, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    const response = await fch("/test");

    expect(response.status).toBe(200);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
      skipCache: true,
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("should redirect when retry also returns 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      http.get("http://localhost:3000/test", ({ request }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    const fch = context.store.get(fetch$);
    const response = await fch("/test");

    expect(response.status).toBe(401);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("should skip retry and redirect when refresh returns null", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? null : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      http.get("http://localhost:3000/test", ({ request }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    const fch = context.store.get(fetch$);
    const response = await fch("/test");

    expect(response.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer stale-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("should skip retry when refresh yields the same token", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "same-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockResolvedValue("same-token");

    const authHeaders: string[] = [];
    server.use(
      http.get("http://localhost:3000/test", ({ request }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json(
          { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    const fch = context.store.get(fetch$);
    const response = await fch("/test");

    expect(response.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer same-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("should replay Request body when retrying on 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const receivedBodies: string[] = [];
    let calls = 0;
    server.use(
      http.post("http://localhost:3000/api/zero/items", async ({ request }) => {
        calls += 1;
        receivedBodies.push(await request.text());
        if (calls === 1) {
          return HttpResponse.json(
            { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }
        return HttpResponse.json({ ok: true }, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    const body = JSON.stringify({ name: "example" });
    const response = await fch(
      new Request("/api/zero/items", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(receivedBodies).toStrictEqual([body, body]);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });
});

describe("other fetch parameters", () => {
  it("should preserve other RequestInit parameters", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler("post", "http://localhost:3000/test", captured),
    );

    const fch = context.store.get(fetch$);

    await fch("/test", {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
    });

    expect(captured.request).not.toBeNull();
    expect(captured.request?.method).toBe("POST");
    expect(captured.request?.body).toBe('{"data":"test"}');
  });

  it("should handle Request object", async () => {
    const captured: { request: CapturedRequest | null } = { request: null };

    server.use(
      createCaptureHandler(
        "post",
        "http://localhost:3000/api/zero/users",
        captured,
      ),
    );

    const fch = context.store.get(fetch$);
    await fch(new Request("/api/zero/users", { method: "POST" }));

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe("http://localhost:3000/api/zero/users");
    expect(captured.request?.method).toBe("POST");
  });
});
