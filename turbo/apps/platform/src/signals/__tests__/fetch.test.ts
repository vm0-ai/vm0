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
import { describe, expect, it, vi } from "vitest";
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

describe("apiBackend routing", () => {
  function captureItemHosts(
    method: "get" | "post" | "put" | "patch" | "delete",
  ) {
    const hosts: string[] = [];
    server.use(
      http[method]("*/api/zero/items", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );
    return hosts;
  }

  it("keeps GET and POST on www when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const getHosts = captureItemHosts("get");
    const postHosts = captureItemHosts("post");
    const fch = context.store.get(fetch$);
    await fch("/api/zero/items");
    await fch("/api/zero/items", { method: "POST" });

    expect(getHosts).toStrictEqual(["www.vm0.ai"]);
    expect(postHosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("is method-aware: routes an allowlisted GET to api but a non-allowlisted method on the same path to www", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const getHosts: string[] = [];
    const postHosts: string[] = [];
    server.use(
      http.get("*/api/zero/voice-io/quota", ({ request }) => {
        getHosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
      http.post("*/api/zero/voice-io/quota", ({ request }) => {
        postHosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/voice-io/quota");
    await fch("/api/zero/voice-io/quota", { method: "POST" });

    // Only GET is allowlisted for this path; POST falls through to www.
    expect(getHosts).toStrictEqual(["api.vm0.ai"]);
    expect(postHosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("routes allowlisted dynamic :id paths to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    server.use(
      http.get("*/api/zero/runs/:id", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/runs/00000000-0000-0000-0000-000000000001");

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes newly-migrated billing/onboarding/attribution paths to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    function capture(method: "get" | "post", pattern: string): void {
      server.use(
        http[method](pattern, ({ request }) => {
          hosts.push(`${method.toUpperCase()} ${new URL(request.url).host}`);
          return new Response(null, { status: 200 });
        }),
      );
    }
    capture("get", "*/api/zero/billing/status");
    capture("post", "*/api/zero/billing/checkout");
    capture("post", "*/api/zero/billing/redeem/:campaign");
    capture("post", "*/api/zero/onboarding/setup");
    capture("post", "*/api/zero/attribution/signup");

    const fch = context.store.get(fetch$);
    await fch("/api/zero/billing/status");
    await fch("/api/zero/billing/checkout", { method: "POST" });
    await fch("/api/zero/billing/redeem/spring", { method: "POST" });
    await fch("/api/zero/onboarding/setup", { method: "POST" });
    await fch("/api/zero/attribution/signup", { method: "POST" });

    expect(hosts).toStrictEqual([
      "GET api.vm0.ai",
      "POST api.vm0.ai",
      "POST api.vm0.ai",
      "POST api.vm0.ai",
      "POST api.vm0.ai",
    ]);
  });

  it("routes connector/integration data to api but keeps connector oauth flows on www", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    function capture(method: "get" | "post" | "delete", pattern: string): void {
      server.use(
        http[method](pattern, ({ request }) => {
          hosts.push(`${method.toUpperCase()} ${new URL(request.url).host}`);
          return new Response(null, { status: 200 });
        }),
      );
    }
    capture("get", "*/api/zero/connectors");
    capture("delete", "*/api/zero/connectors/:type");
    capture("get", "*/api/zero/integrations/slack");
    // OAuth flows under the connectors subtree must stay on www even though
    // their /connectors/:type prefix is now migrated.
    capture("post", "*/api/zero/connectors/:type/oauth/start");

    const fch = context.store.get(fetch$);
    await fch("/api/zero/connectors");
    await fch("/api/zero/connectors/slack", { method: "DELETE" });
    await fch("/api/zero/integrations/slack");
    await fch("/api/zero/connectors/slack/oauth/start", { method: "POST" });

    expect(hosts).toStrictEqual([
      "GET api.vm0.ai",
      "DELETE api.vm0.ai",
      "GET api.vm0.ai",
      "POST www.vm0.ai",
    ]);
  });

  it("routes the recovered first-party routes (memory-activity, org-logo, voice stt/tts) to api", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    function capture(method: "get" | "post" | "delete", pattern: string): void {
      server.use(
        http[method](pattern, ({ request }) => {
          hosts.push(`${method.toUpperCase()} ${new URL(request.url).host}`);
          return new Response(null, { status: 200 });
        }),
      );
    }
    capture("get", "*/api/zero/memory/activity");
    capture("post", "*/api/zero/org/logo");
    capture("get", "*/api/zero/org/logo");
    capture("post", "*/api/zero/voice-io/stt");
    capture("post", "*/api/zero/voice-io/tts");

    const fch = context.store.get(fetch$);
    await fch("/api/zero/memory/activity");
    await fch("/api/zero/org/logo", { method: "POST" });
    await fch("/api/zero/org/logo");
    await fch("/api/zero/voice-io/stt", { method: "POST" });
    await fch("/api/zero/voice-io/tts", { method: "POST" });

    expect(hosts).toStrictEqual([
      "GET api.vm0.ai",
      "POST api.vm0.ai",
      "GET api.vm0.ai",
      "POST api.vm0.ai",
      "POST api.vm0.ai",
    ]);
  });

  it("routes push-subscriptions POST to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    server.use(
      http.post("*/api/zero/push-subscriptions", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/push-subscriptions", { method: "POST" });

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("does not let a :param template over-match a shorter parent path", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    // `/api/zero/runs/:id` is allowlisted for GET, but the bare parent
    // `/api/zero/runs` is only allowlisted for POST. A GET to the parent must
    // not be absorbed by the `:id` template (segment counts differ), so it
    // falls through to www.
    const hosts: string[] = [];
    server.use(
      http.get("*/api/zero/runs", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/runs");

    expect(hosts).toStrictEqual(["www.vm0.ai"]);
  });

  it("routes policy allowlisted user preferences string paths to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    server.use(
      http.get("*/api/zero/user-preferences", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/zero/user-preferences");

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes policy allowlisted user preferences Request inputs to api host when apiBackend is off", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    server.use(
      http.post("*/api/zero/user-preferences", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch(
      new Request("/api/zero/user-preferences", {
        method: "POST",
        body: JSON.stringify({ sendMode: "cmd-enter" }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("uses RequestInit method overrides for policy allowlisted user preferences Request inputs", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const hosts: string[] = [];
    server.use(
      http.post("*/api/zero/user-preferences", ({ request }) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 200 });
      }),
    );

    const fch = context.store.get(fetch$);
    await fch(new Request("/api/zero/user-preferences"), {
      method: "POST",
    });

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes GET and POST to api host when apiBackend is on", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const getHosts = captureItemHosts("get");
    const postHosts = captureItemHosts("post");
    const fch = context.store.get(fetch$);
    await fch("/api/zero/items");
    await fch("/api/zero/items", { method: "POST" });

    expect(getHosts).toStrictEqual(["api.vm0.ai"]);
    expect(postHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes PATCH and DELETE the same way as POST when apiBackend is on", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const patchHosts = captureItemHosts("patch");
    const deleteHosts = captureItemHosts("delete");
    const fch = context.store.get(fetch$);

    await fch("/api/zero/items", { method: "PATCH" });
    await fch("/api/zero/items", { method: "DELETE" });

    expect(patchHosts).toStrictEqual(["api.vm0.ai"]);
    expect(deleteHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("routes Request input through apiBackend", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const hosts = captureItemHosts("post");
    const fch = context.store.get(fetch$);
    await fch(new Request("/api/zero/items", { method: "POST" }));

    expect(hosts).toStrictEqual(["api.vm0.ai"]);
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
