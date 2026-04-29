import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { HTTPException } from "hono/http-exception";
import { http, HttpResponse } from "msw";
import { z } from "zod";

import { createApp } from "../app-factory";
import { mockEnv } from "../lib/env";
import { server } from "../mocks/server";
import { ROUTES } from "../signals/route";
import { accept, setupApp, testContext } from "./test-helpers";

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
      let observedRequest: Request | undefined;
      server.use(
        http.get("https://www.vm0.ai/api/agent/runs", ({ request }) => {
          observedRequest = request;
          return HttpResponse.json({ runs: [] });
        }),
      );

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/agent/runs?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer legacy" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({ runs: [] });
      expect(observedRequest?.url).toBe(
        "https://www.vm0.ai/api/agent/runs?limit=5",
      );
      expect(observedRequest?.headers.get("authorization")).toBe(
        "Bearer legacy",
      );
    });

    it("forwards POST bodies to the upstream", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      let observedBody: string | undefined;
      server.use(
        http.post(
          "https://www.vm0.ai/api/v1/chat-threads/messages",
          async ({ request }) => {
            observedBody = await request.text();
            return new HttpResponse(null, { status: 202 });
          },
        ),
      );

      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/v1/chat-threads/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      });

      expect(response.status).toBe(202);
      expect(observedBody).toBe('{"hello":"world"}');
    });

    it("proxies realtime token requests without stale forwarded host metadata", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      const captured: {
        urls: string[];
        authorization: string[];
        origins: string[];
        bodies: string[];
        forwarded: (string | null)[];
        forwardedHost: (string | null)[];
        forwardedPort: (string | null)[];
        forwardedProto: (string | null)[];
      } = {
        urls: [],
        authorization: [],
        origins: [],
        bodies: [],
        forwarded: [],
        forwardedHost: [],
        forwardedPort: [],
        forwardedProto: [],
      };
      server.use(
        http.post(
          "https://www.vm0.ai/api/zero/realtime/token",
          async ({ request }) => {
            captured.urls.push(request.url);
            captured.authorization.push(
              request.headers.get("authorization") ?? "",
            );
            captured.origins.push(request.headers.get("origin") ?? "");
            captured.bodies.push(await request.text());
            captured.forwarded.push(request.headers.get("forwarded"));
            captured.forwardedHost.push(
              request.headers.get("x-forwarded-host"),
            );
            captured.forwardedPort.push(
              request.headers.get("x-forwarded-port"),
            );
            captured.forwardedProto.push(
              request.headers.get("x-forwarded-proto"),
            );
            return HttpResponse.json({ token: "proxied" });
          },
        ),
      );

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
      expect(captured.urls).toStrictEqual([
        "https://www.vm0.ai/api/zero/realtime/token",
      ]);
      expect(captured.authorization).toStrictEqual(["Bearer clerk-session"]);
      expect(captured.origins).toStrictEqual(["https://app.vm0.ai"]);
      expect(captured.bodies).toStrictEqual(["{}"]);
      expect(captured.forwarded).toStrictEqual([null]);
      expect(captured.forwardedHost).toStrictEqual([null]);
      expect(captured.forwardedPort).toStrictEqual([null]);
      expect(captured.forwardedProto).toStrictEqual([null]);
    });

    it("preserves multiple set-cookie response headers", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      server.use(
        http.get("https://www.vm0.ai/api/connectors/github/authorize", () => {
          return new HttpResponse(null, {
            status: 302,
            headers: [
              ["location", "https://github.com/login/oauth/authorize"],
              ["set-cookie", "oauth_state=abc; Path=/; HttpOnly"],
              ["set-cookie", "oauth_pkce=def; Path=/; HttpOnly"],
            ],
          });
        }),
      );

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

    it("returns 404 when VM0_WEB_URL is not configured", async () => {
      // No msw handler registered — if the proxy tried to fetch, msw would
      // throw on the unhandled request. The 404 path must short-circuit.
      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/agent/runs", { method: "GET" });

      expect(response.status).toBe(404);
    });

    it("does not proxy when a registered route matches", async () => {
      mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
      const app = createApp({ signal: context.signal });
      const response = await app.request("/health", { method: "GET" });

      expect(response.status).toBe(200);
    });
  });
});
