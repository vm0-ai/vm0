import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import { HttpResponse, http, passthrough } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { devArtifactFetchProxy } from "./dev-artifact-fetch-proxy.ts";
import { server as mockServer } from "./src/mocks/server.ts";

const ALLOWED_OKOU_TARGETS = [
  "https://cdn.okou.io/artifacts/user_1/artifact_1/report.html",
  "https://static.okou.io/web/assets/presentation.html",
  "https://demo.okou.app/",
] as const;

let proxyOrigin = "";
let proxyServer: Server | null = null;
let viteServer: ViteDevServer | null = null;

beforeAll(async () => {
  viteServer = await createViteServer({
    configFile: false,
    logLevel: "silent",
    plugins: [devArtifactFetchProxy()],
    server: { middlewareMode: true },
  });
  proxyServer = createHttpServer(viteServer.middlewares);
  proxyServer.listen(0, "127.0.0.1");
  await once(proxyServer, "listening");

  const address = proxyServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the proxy test server to listen on a TCP port");
  }
  proxyOrigin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  mockServer.use(
    http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => {
      return passthrough();
    }),
    http.get(
      /^https:\/\/(?:cdn\.okou\.io|static\.okou\.io|demo\.okou\.app)\//,
      ({ request }) => {
        const target = new URL(request.url);
        return new HttpResponse(target.hostname, {
          status: 206,
          headers: {
            "cache-control": "public, max-age=60",
            "content-type": "text/plain",
          },
        });
      },
    ),
  );
});

afterAll(async () => {
  const activeProxyServer = proxyServer;
  if (activeProxyServer?.listening) {
    await new Promise<void>((resolve, reject) => {
      activeProxyServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  await viteServer?.close();
});

function proxyUrl(target: string): string {
  return `${proxyOrigin}/__vm0-dev-artifact-fetch?url=${encodeURIComponent(
    target,
  )}`;
}

describe("development artifact fetch proxy", () => {
  it.each(ALLOWED_OKOU_TARGETS)(
    "forwards the exact Okou target %s",
    async (target) => {
      const response = await fetch(proxyUrl(target));

      expect(response.status).toBe(206);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=60",
      );
      expect(response.headers.get("content-type")).toContain("text/plain");
      await expect(response.text()).resolves.toBe(new URL(target).hostname);
    },
  );

  it("rejects an Okou lookalike at the HTTP boundary", async () => {
    const response = await fetch(
      proxyUrl("https://static.okou.io.attacker.example/payload.html"),
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Forbidden");
  });
});
