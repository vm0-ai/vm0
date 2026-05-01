import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createApp } from "../app-factory";
import { mockEnv } from "../lib/env";
import { ROUTES } from "../signals/route";
import { useUndiciMock } from "./setup";
import { accept, setupApp, testContext } from "./test-helpers";

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lower = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === "function") {
    const result = (headers as { get(n: string): string | null }).get(name);
    return result ?? undefined;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

async function readBodyAsString(body: unknown): Promise<string> {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Buffer) {
    return body.toString("utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body === null) {
    return "";
  }
  if (
    typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error(
    `Unexpected mock body type: ${(body as object).constructor.name}`,
  );
}

const c = initContract();

const errorTestContract = c.router({
  boom: {
    method: "GET",
    path: "/__test/boom",
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

  describe("legacy fallthrough proxy", () => {
    it("proxies unmatched paths to VM0_WEB_URL when configured", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      let observedPath: string | undefined;
      let observedAuthorization: string | undefined;
      useUndiciMock()
        .get("https://www.vm0.ai")
        .intercept({ path: "/api/agent/runs?limit=5", method: "GET" })
        .reply((opts) => {
          observedPath = opts.path;
          observedAuthorization = headerValue(opts.headers, "authorization");
          return {
            statusCode: 200,
            data: JSON.stringify({ runs: [] }),
            responseOptions: {
              headers: { "content-type": "application/json" },
            },
          };
        });

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/agent/runs?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer legacy" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({ runs: [] });
      expect(observedPath).toBe("/api/agent/runs?limit=5");
      expect(observedAuthorization).toBe("Bearer legacy");
    });

    it("forwards POST bodies to the upstream", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      let observedBody: Promise<string> | undefined;
      useUndiciMock()
        .get("https://www.vm0.ai")
        .intercept({ path: "/api/v1/chat-threads/messages", method: "POST" })
        .reply((opts) => {
          observedBody = readBodyAsString(opts.body);
          return { statusCode: 202, data: "" };
        });

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/v1/chat-threads/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      });

      expect(response.status).toBe(202);
      await expect(observedBody).resolves.toBe('{"hello":"world"}');
    });

    it("proxies realtime token requests without stale forwarded host metadata", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      const captured: {
        paths: string[];
        authorization: string[];
        origins: string[];
        bodies: Promise<string>[];
        forwarded: (string | undefined)[];
        forwardedHost: (string | undefined)[];
        forwardedPort: (string | undefined)[];
        forwardedProto: (string | undefined)[];
      } = {
        paths: [],
        authorization: [],
        origins: [],
        bodies: [],
        forwarded: [],
        forwardedHost: [],
        forwardedPort: [],
        forwardedProto: [],
      };
      useUndiciMock()
        .get("https://www.vm0.ai")
        .intercept({ path: "/api/zero/realtime/token", method: "POST" })
        .reply((opts) => {
          captured.paths.push(opts.path);
          captured.authorization.push(
            headerValue(opts.headers, "authorization") ?? "",
          );
          captured.origins.push(headerValue(opts.headers, "origin") ?? "");
          captured.bodies.push(readBodyAsString(opts.body));
          captured.forwarded.push(headerValue(opts.headers, "forwarded"));
          captured.forwardedHost.push(
            headerValue(opts.headers, "x-forwarded-host"),
          );
          captured.forwardedPort.push(
            headerValue(opts.headers, "x-forwarded-port"),
          );
          captured.forwardedProto.push(
            headerValue(opts.headers, "x-forwarded-proto"),
          );
          return {
            statusCode: 200,
            data: JSON.stringify({ token: "proxied" }),
            responseOptions: {
              headers: { "content-type": "application/json" },
            },
          };
        });

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/zero/realtime/token", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
          forwarded: "host=api.vm0.ai;proto=https",
          origin: "https://app.vm0.ai",
          "x-forwarded-host": "api.vm0.ai",
          "x-forwarded-port": "443",
          "x-forwarded-proto": "https",
        },
        body: "{}",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        token: "proxied",
      });
      expect(captured.paths).toStrictEqual(["/api/zero/realtime/token"]);
      expect(captured.authorization).toStrictEqual(["Bearer clerk-session"]);
      expect(captured.origins).toStrictEqual(["https://app.vm0.ai"]);
      await expect(Promise.all(captured.bodies)).resolves.toStrictEqual(["{}"]);
      expect(captured.forwarded).toStrictEqual([undefined]);
      expect(captured.forwardedHost).toStrictEqual([undefined]);
      expect(captured.forwardedPort).toStrictEqual([undefined]);
      expect(captured.forwardedProto).toStrictEqual([undefined]);
    });

    it("preserves multiple set-cookie response headers", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      useUndiciMock()
        .get("https://www.vm0.ai")
        .intercept({
          path: "/api/connectors/github/authorize",
          method: "GET",
        })
        .reply(302, "", {
          headers: {
            location: "https://github.com/login/oauth/authorize",
            "set-cookie": [
              "oauth_state=abc; Path=/; HttpOnly",
              "oauth_pkce=def; Path=/; HttpOnly",
            ],
          },
        });

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/connectors/github/authorize", {
        method: "GET",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(response.headers.getSetCookie()).toStrictEqual([
        "oauth_state=abc; Path=/; HttpOnly",
        "oauth_pkce=def; Path=/; HttpOnly",
      ]);
    });

    it("does not proxy when a registered route matches", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
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
});
