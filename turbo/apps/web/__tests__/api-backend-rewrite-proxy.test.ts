import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { parse, type UrlWithParsedQuery } from "node:url";
import { http as mswHttp, passthrough } from "msw";
import { describe, expect, it } from "vitest";
import { matchesApiBackendRewritePath } from "../api-backend-rewrites";
import { server } from "../src/mocks/server";

type ProxyRequest = (
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: UrlWithParsedQuery,
  upgradeHead: Buffer | undefined,
  reqBody: Buffer | undefined,
  proxyTimeout: number | null,
) => Promise<void>;

interface EchoPayload {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly body: string;
}

const require = createRequire(import.meta.url);
const { proxyRequest } =
  require("next/dist/server/lib/router-utils/proxy-request.js") as {
    readonly proxyRequest: ProxyRequest;
  };

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function endWithError(response: ServerResponse, error: unknown): void {
  if (!response.headersSent) {
    response.statusCode = 500;
  }
  response.end(String(error));
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withRewriteProxy<T>(
  handler: (request: IncomingMessage) => Promise<Response>,
  test: (origin: string) => Promise<T>,
): Promise<T> {
  const backend = createServer((request, response) => {
    void (async () => {
      const result = await handler(request);
      response.statusCode = result.status;
      result.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") {
          response.setHeader(key, value);
        }
      });
      for (const cookie of result.headers.getSetCookie()) {
        response.appendHeader("set-cookie", cookie);
      }
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch((error: unknown) => {
      endWithError(response, error);
    });
  });

  const backendPort = await listen(backend);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const proxy = createServer((request, response) => {
    const target = parse(`${backendOrigin}${request.url ?? "/"}`, true);
    proxyRequest(request, response, target, undefined, undefined, null).catch(
      (error: unknown) => {
        endWithError(response, error);
      },
    );
  });

  const proxyPort = await listen(proxy);
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  server.use(
    mswHttp.all(`${backendOrigin}/*`, () => {
      return passthrough();
    }),
    mswHttp.all(`${proxyOrigin}/*`, () => {
      return passthrough();
    }),
  );
  try {
    return await test(proxyOrigin);
  } finally {
    await close(proxy);
    await close(backend);
  }
}

describe("API backend rewrite proxy behavior", () => {
  it("routes hosted-site deployment endpoints to the API backend", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/host/deployments/prepare"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/host/deployments/eca12aa0-4c26-48c7-85d8-b3af58d408c7/complete",
      ),
    ).toBe(true);
  });

  it("matches the zero voice-io quota rewrite exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/quota")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/quota/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/speech")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/stt")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/tts")).toBe(false);
  });

  it("matches the usage insight rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/insight")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/insight/extra")).toBe(
      false,
    );
  });

  it("forwards method, query, cookies, and request body", async () => {
    await withRewriteProxy(
      async (request) => {
        return Response.json({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: await readRequestBody(request),
        });
      },
      async (origin) => {
        const response = await fetch(
          `${origin}/api/device-token?from=web-rewrite`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "session=opaque",
            },
            body: JSON.stringify({ device_type: "bb0" }),
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/device-token?from=web-rewrite");
        expect(payload.headers.cookie).toBe("session=opaque");
        expect(payload.headers["x-forwarded-host"]).toContain("127.0.0.1:");
        expect(payload.body).toBe(JSON.stringify({ device_type: "bb0" }));
      },
    );
  });

  it("preserves OAuth redirects and multiple Set-Cookie headers", async () => {
    await withRewriteProxy(
      async () => {
        return new Response(null, {
          status: 307,
          headers: [
            ["location", "https://auth.example.test/oauth?state=abc"],
            [
              "set-cookie",
              "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
            ],
            [
              "set-cookie",
              "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
            ],
          ],
        });
      },
      async (origin) => {
        const response = await fetch(
          `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/authorize?from=settings`,
          { redirect: "manual" },
        );

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
          "https://auth.example.test/oauth?state=abc",
        );
        expect(response.headers.getSetCookie()).toStrictEqual([
          "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
          "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
        ]);
      },
    );
  });
});
