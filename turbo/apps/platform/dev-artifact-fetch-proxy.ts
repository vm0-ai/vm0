import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { PluginOption } from "vite";

import { isAllowedDevArtifactFetchUrl } from "./src/lib/dev-artifact-fetch-url.ts";

const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__okou-dev-artifact-fetch";
const DEV_ARTIFACT_FETCH_PROXY_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
] as const;

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

    const upstreamRequest = https.get(target, (upstream) => {
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

export function devArtifactFetchProxy(): PluginOption {
  return {
    name: "okou-dev-artifact-fetch-proxy",
    configureServer(server) {
      server.middlewares.use(DEV_ARTIFACT_FETCH_PROXY_PATH, (req, res) => {
        handleDevArtifactFetchProxyRequest(req, res);
      });
    },
  };
}
