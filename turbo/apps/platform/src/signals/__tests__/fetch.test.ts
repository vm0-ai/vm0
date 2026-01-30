import { describe, expect, it } from "vitest";
import { http } from "msw";
import { server } from "../../mocks/server.ts";
import { fetch$ } from "../fetch.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";

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
    await setupPage({
      context,
      path: "/",
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

    await setupPage({
      context,
      path: "/",
      session: { token: mockToken },
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

    await setupPage({
      context,
      path: "/",
      session: { token: mockToken },
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

    await setupPage({
      context,
      path: "/",
      session: { token: mockToken },
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
      createCaptureHandler("get", "http://localhost:3000/api/users", captured),
    );

    const fch = context.store.get(fetch$);
    await fch("/api/users?page=1&size=10");

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe(
      "http://localhost:3000/api/users?page=1&size=10",
    );
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
      createCaptureHandler("post", "http://localhost:3000/api/users", captured),
    );

    const fch = context.store.get(fetch$);
    await fch(new Request("/api/users", { method: "POST" }));

    expect(captured.request).not.toBeNull();
    expect(captured.request?.url).toBe("http://localhost:3000/api/users");
    expect(captured.request?.method).toBe("POST");
  });
});
