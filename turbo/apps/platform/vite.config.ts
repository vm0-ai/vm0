import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { get as httpsGet } from "node:https";
import { defineConfig, type PluginOption } from "vite";

const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__vm0-dev-artifact-fetch";
const DEV_ARTIFACT_FETCH_PROXY_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
] as const;

function isAllowedDevArtifactFetchUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  return (
    url.hostname === "cdn.vm0.io" ||
    url.hostname === "cdn.vm7.io" ||
    url.hostname.endsWith(".sites.vm0.io") ||
    url.hostname.endsWith(".sites.vm7.io")
  );
}

function sendBadGateway(res: ServerResponse): void {
  res.statusCode = 502;
  res.end("Bad gateway");
}

function handleDevArtifactFetchProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  try {
    const requestUrl = new URL(req.url ?? "", "http://localhost");
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget) {
      res.statusCode = 400;
      res.end("Missing url");
      return;
    }

    if (!URL.canParse(rawTarget)) {
      res.statusCode = 400;
      res.end("Invalid url");
      return;
    }

    const target = new URL(rawTarget);
    if (!isAllowedDevArtifactFetchUrl(target)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const upstreamRequest = httpsGet(target, (upstream) => {
      res.statusCode = upstream.statusCode ?? 502;
      for (const header of DEV_ARTIFACT_FETCH_PROXY_HEADERS) {
        const value = upstream.headers[header];
        if (value) {
          res.setHeader(header, value);
        }
      }
      upstream.pipe(res);
    });
    upstreamRequest.on("error", () => {
      sendBadGateway(res);
    });
  } catch {
    sendBadGateway(res);
  }
}

function devArtifactFetchProxy(): PluginOption {
  return {
    name: "vm0-dev-artifact-fetch-proxy",
    configureServer(server) {
      server.middlewares.use(DEV_ARTIFACT_FETCH_PROXY_PATH, (req, res) => {
        handleDevArtifactFetchProxyRequest(req, res);
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_URL || "/",
  envPrefix: ["VITE_", "PUBLIC_"],
  plugins: [
    tailwindcss(),
    react(),
    devArtifactFetchProxy(),
    // Sentry source map upload (production builds only)
    process.env.SENTRY_AUTH_TOKEN &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        sourcemaps: {
          // Delete source maps after upload to avoid exposing them
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
  ].filter(Boolean),
  server: {
    port: 3002,
    strictPort: true,
    host: true,
    allowedHosts: ["app.vm7.ai", "vm7.ai", "www.vm7.ai"],
  },
  build: {
    outDir: "dist",
    // Generate source maps for Sentry (uploaded and removed by plugin)
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
  },
});
