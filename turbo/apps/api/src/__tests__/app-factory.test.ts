import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { EVENT } from "@axiomhq/logging";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { vi } from "vitest";
import { createApp } from "../app-factory";
import { mockEnv } from "../lib/env";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { ROUTES } from "../signals/route";
import { accept, setupApp, testContext } from "./test-helpers";

// eslint-disable-next-line api/no-test-vi-mocks
const { mockFlushLogs } = vi.hoisted(() => {
  return {
    // eslint-disable-next-line api/no-test-vi-mocks
    mockFlushLogs: vi.fn(),
  };
});

mockFlushLogs.mockResolvedValue(undefined);

// eslint-disable-next-line api/no-test-vi-mocks
vi.mock("../lib/log", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/log")>("../lib/log");
  return { ...actual, flushLogs: mockFlushLogs };
});

const c = initContract();

const errorTestContract = c.router({
  boom: {
    method: "GET",
    path: "/__test/boom",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  boomById: {
    method: "GET",
    path: "/__test/boom/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
  missing: {
    method: "GET",
    path: "/__test/missing",
    responses: {
      404: z.string(),
    },
  },
  unavailable: {
    method: "GET",
    path: "/__test/unavailable",
    responses: {
      503: z.string(),
    },
  },
  aborted: {
    method: "GET",
    path: "/__test/aborted",
    responses: {
      500: z.object({ error: z.string() }),
    },
  },
});

describe("createApp", () => {
  const context = testContext();

  it("captures unhandled errors and returns a sanitized response", async () => {
    const error = new Error("boom");
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [...ROUTES, { route: errorTestContract.boom, handler: handler$ }],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("logs sanitized root-cause fields for unhandled errors", async () => {
    const cause = new Error(
      "column chat_threads.last_read_message_id does not exist for user test@example.com at https://example.test/callback?token=secret Bearer abcdef1234567890 123456789012 01890f9d-7b0d-7ccf-8f02-7d8a0c1b2c3d org_abc123456789 user_def987654321 API key: sk-live-secret client secret=client-secret refresh_token=refresh-secret Authorization: Basic basic-secret",
    );
    const error = Object.assign(
      new Error("wrapped database failure", { cause }),
      {
        code: "42703",
      },
    );
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.boomById, handler: handler$ },
      ],
    })(errorTestContract);

    const response = await accept(
      client.boomById({
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe(
      "Unhandled request error: column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
    );

    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary:
        "column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
      route: "/__test/boom/:id",
      method: "GET",
      errorCode: "42703",
      error: expect.objectContaining({
        message: "wrapped database failure",
        code: "42703",
        cause: expect.objectContaining({
          message: cause.message,
        }),
      }),
    });
    expect(logFields[EVENT]).toMatchObject({
      source: "api",
      type: "unhandled_request_error",
      errorSummary:
        "column chat_threads.last_read_message_id does not exist for user [email] at [url] Bearer [redacted] [number] [id] [id] [id] API key=[redacted] client secret=[redacted] refresh_token=[redacted] Authorization=[redacted]",
      route: "/__test/boom/:id",
      method: "GET",
      errorCode: "42703",
    });

    const serialized = JSON.stringify({
      message,
      errorSummary: logFields.errorSummary,
      route: logFields.route,
    });
    expect(serialized).not.toContain("test@example.com");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("abcdef1234567890");
    expect(serialized).not.toContain("123456789012");
    expect(serialized).not.toContain("01890f9d-7b0d-7ccf-8f02-7d8a0c1b2c3d");
    expect(serialized).not.toContain("org_abc123456789");
    expect(serialized).not.toContain("user_def987654321");
    expect(serialized).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("basic-secret");
  });

  it("bounds long unhandled error summaries", async () => {
    const error = new Error("x".repeat(10_000));
    const expectedSummary = `${"x".repeat(237)}...`;
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [...ROUTES, { route: errorTestContract.boom, handler: handler$ }],
    })(errorTestContract);

    await accept(client.boom(), [500]);

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields.errorSummary).toBe(expectedSummary);
    expect(message).toBe(`Unhandled request error: ${expectedSummary}`);
  });

  it("summarizes response validation failures without schema details", async () => {
    const handler$ = computed(() => {
      return { status: 500, body: { error: 123 } };
    });
    const client = setupApp({
      context,
      routes: [...ROUTES, { route: errorTestContract.boom, handler: handler$ }],
    })(errorTestContract);

    const response = await accept(client.boom(), [500]);

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.sentry.captureException).toHaveBeenCalledOnce();

    const [message, fields] =
      context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(message).toBe("Unhandled request error: response validation failed");

    const logFields = fields as Record<PropertyKey, unknown>;
    expect(logFields).toMatchObject({
      type: "unhandled_request_error",
      errorSummary: "response validation failed",
      route: "/__test/boom",
      method: "GET",
    });
    expect(logFields[EVENT]).toMatchObject({
      source: "api",
      type: "unhandled_request_error",
      errorSummary: "response validation failed",
      route: "/__test/boom",
      method: "GET",
    });
  });

  it("passes through expected HTTP client errors without capturing them", async () => {
    const error = new HTTPException(404, { message: "Missing" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.missing, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.missing(), [404]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not capture AbortError", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.aborted, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.aborted(), [500]);

    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures HTTP server errors while preserving their response", async () => {
    const error = new HTTPException(503, { message: "Unavailable" });
    const handler$ = computed((): never => {
      throw error;
    });
    const client = setupApp({
      context,
      routes: [
        ...ROUTES,
        { route: errorTestContract.unavailable, handler: handler$ },
      ],
    })(errorTestContract);

    await accept(client.unavailable(), [503]);

    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(error);
  });

  describe("not found", () => {
    it("redirects root auth pages to the configured web origin", async () => {
      mockEnv("VM0_WEB_URL", "https://pr-123-www.vm6.ai");
      const app = createApp({ signal: context.signal });
      const response = await app.request(
        "https://pr-123-api.vm6.ai/sign-up?redirect_url=https%3A%2F%2Fstaging-www.vm6.ai%2Fonboarding%2F491858%3Fdomain%3Dpr-123-api.vm6.ai",
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://pr-123-www.vm6.ai/sign-up?redirect_url=https%3A%2F%2Fstaging-www.vm6.ai%2Fonboarding%2F491858%3Fdomain%3Dpr-123-api.vm6.ai",
      );
    });

    it("returns a 404 JSON response for unmatched routes", async () => {
      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/legacy/fallthrough?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer legacy" },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: "Not found",
      });
    });

    it("keeps registered routes matched normally", async () => {
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
    });
  });

  describe("cors", () => {
    it("echoes allowed cross-origin on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm0.ai" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm0.ai",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

    it("echoes exact vm7 app origin with port on registered route responses", async () => {
      mockEnv("ENV", "production");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });

    it("answers preflight without invoking the route handler", async () => {
      mockEnv("ENV", "production");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/zero/org", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.vm0.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm0.ai",
      );
      expect(response.headers.get("access-control-allow-methods")).toContain(
        "GET",
      );
    });

    it("rejects disallowed origins by omitting the allow-origin header", async () => {
      mockEnv("ENV", "production");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://evil.example.com" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("allows *.vm7.ai over http only in development", async () => {
      mockEnv("ENV", "development");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", {
        method: "GET",
        headers: { origin: "https://app.vm7.ai:8443" },
      });

      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.vm7.ai:8443",
      );
    });
  });

  describe("flush middleware", () => {
    it("calls flushLogs after a successful response", async () => {
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
      expect(mockFlushLogs).toHaveBeenCalledWith();
    });
  });
});
