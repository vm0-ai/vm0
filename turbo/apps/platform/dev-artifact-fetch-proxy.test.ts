import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { HttpResponse, http, passthrough } from "msw";
import { describe, expect, it } from "vitest";
import { createServer as createViteServer } from "vite";

import { devArtifactFetchProxy } from "./dev-artifact-fetch-proxy.ts";
import { server as mockServer } from "./src/mocks/server.ts";

const ALLOWED_OKOU_TARGETS = [
  "https://a.okou.io/0123456789.html",
  "https://cdn.okou.io/artifacts/user_1/artifact_1/report.html",
  "https://static.okou.io/web/assets/presentation.html",
  "https://demo.okou.app/",
] as const;

function proxyUrl(proxyOrigin: string, target: string): string {
  return `${proxyOrigin}/__vm0-dev-artifact-fetch?url=${encodeURIComponent(
    target,
  )}`;
}

describe("development artifact fetch proxy", () => {
  it("forwards exact Okou targets and rejects lookalikes at the HTTP boundary", async () => {
    const viteServer = await createViteServer({
      configFile: false,
      logLevel: "silent",
      plugins: [devArtifactFetchProxy()],
      server: { middlewareMode: true },
    });
    const proxyServer = createHttpServer(viteServer.middlewares);

    try {
      proxyServer.listen(0, "127.0.0.1");
      await once(proxyServer, "listening");

      const address = proxyServer.address();
      if (!address || typeof address === "string") {
        throw new Error(
          "Expected the proxy test server to listen on a TCP port",
        );
      }
      const proxyOrigin = `http://127.0.0.1:${address.port}`;

      mockServer.use(
        http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => {
          return passthrough();
        }),
        http.get(
          /^https:\/\/(?:a\.okou\.io|cdn\.okou\.io|static\.okou\.io|demo\.okou\.app)\//,
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

      for (const target of ALLOWED_OKOU_TARGETS) {
        const response = await fetch(proxyUrl(proxyOrigin, target));

        expect(response.status).toBe(206);
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=60",
        );
        expect(response.headers.get("content-type")).toContain("text/plain");
        await expect(response.text()).resolves.toBe(new URL(target).hostname);
      }

      const rejectedResponse = await fetch(
        proxyUrl(
          proxyOrigin,
          "https://static.okou.io.attacker.example/payload.html",
        ),
      );

      expect(rejectedResponse.status).toBe(403);
      await expect(rejectedResponse.text()).resolves.toBe("Forbidden");
    } finally {
      if (proxyServer.listening) {
        const closed = once(proxyServer, "close");
        proxyServer.close();
        await closed;
      }
      await viteServer.close();
    }
  });
});
