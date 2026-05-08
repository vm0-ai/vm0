import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { context as otelContext, propagation } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { type Context, type MiddlewareHandler, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
// oxlint-disable-next-line no-restricted-imports -- app-factory needs the matched route resolver before next(); other signals files use the wrappers from signals/context/hono.
import { routePath } from "hono/route";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { request as undiciRequest, type Dispatcher } from "undici";

import { corsMiddleware } from "./lib/cors";
import { env } from "./lib/env";
import { flushLogs, logger } from "./lib/log";
import { waitUntil } from "./signals/context/wait-until";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";
import {
  registerVoiceChatRelayRoute,
  type RegisterVoiceChatRelayRouteOptions,
} from "./signals/lib/voice-chat-relay/voice-chat-relay-route";
import {
  createInMemoryRelaySessionRepository,
  type RelaySessionRepository,
} from "./signals/lib/voice-chat-relay/relay-session-repository";

const L = logger("App");

// Hop-by-hop headers (RFC 7230 §6.1) — must not be forwarded across a proxy
// hop. We use undici.request rather than fetch so the upstream bytes (and
// their content-encoding) flow through verbatim; that means content-length
// stays meaningful and is NOT stripped here.
const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  host: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

const PROXY_REQUEST_HEADERS: Readonly<Record<string, true>> = {
  forwarded: true,
  "x-forwarded-host": true,
  "x-forwarded-port": true,
  "x-forwarded-proto": true,
};

function isHopByHop(name: string): boolean {
  return Object.hasOwn(HOP_BY_HOP_HEADERS, name.toLowerCase());
}

function isProxyRequestHeader(name: string): boolean {
  return Object.hasOwn(PROXY_REQUEST_HEADERS, name.toLowerCase());
}

// Statuses for which the WHATWG Response constructor rejects a non-null body
// argument (fetch spec: "null body status"). Even an empty stream is a
// non-null body object, so we must hand `null` to `new Response` here — and
// drain the upstream stream separately so undici can release the connection.
const NULL_BODY_STATUSES: Readonly<Record<number, true>> = {
  101: true,
  103: true,
  204: true,
  205: true,
  304: true,
};

function isNullBodyStatus(status: number): boolean {
  return Object.hasOwn(NULL_BODY_STATUSES, status);
}

async function proxyToWeb(context: Context, webUrl: string): Promise<Response> {
  const incoming = new URL(context.req.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, webUrl);

  const requestHeaders: Record<string, string> = {};
  for (const [key, value] of context.req.raw.headers) {
    if (!isHopByHop(key) && !isProxyRequestHeader(key)) {
      requestHeaders[key] = value;
    }
  }

  // GET/HEAD must not carry a body. For everything else, adapt the incoming
  // web ReadableStream into a Node Readable for undici.
  const hasBody = context.req.method !== "GET" && context.req.method !== "HEAD";
  // The dom and node:stream/web flavours of ReadableStream are the same
  // runtime object; TS surfaces them as distinct types because tsconfig pulls
  // in lib.dom alongside @types/node, so coerce through unknown.
  const webBody = context.req.raw.body as unknown as NodeReadableStream | null;
  const requestBody =
    hasBody && webBody ? Readable.fromWeb(webBody) : undefined;

  // undici.request — unlike fetch — does not auto-decompress, so compressed
  // upstream bytes flow through verbatim and the original content-encoding
  // header stays accurate.
  const upstream = await undiciRequest(target, {
    method: context.req.method as Dispatcher.HttpMethod,
    headers: requestHeaders,
    body: requestBody,
    signal: context.req.raw.signal,
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || name === "set-cookie" || isHopByHop(name)) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      responseHeaders.append(name, v);
    }
  }
  const setCookie = upstream.headers["set-cookie"];
  if (setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of list) {
      responseHeaders.append("set-cookie", cookie);
    }
  }

  if (isNullBodyStatus(upstream.statusCode)) {
    upstream.body.resume();
    return new Response(null, {
      status: upstream.statusCode,
      headers: responseHeaders,
    });
  }

  return new Response(Readable.toWeb(upstream.body) as ReadableStream, {
    status: upstream.statusCode,
    headers: responseHeaders,
  });
}

// Stamp the matched route template into OTel baggage so child spans (db
// queries, outbound fetches) can carry `http.route` without reaching back
// into the parent SERVER span. Any code further down the call tree —
// including the pg pool wrapper in `lib/db.ts` — reads it from
// `propagation.getActiveBaggage()`.
//
// `c.req.routePath` reflects the *current* middleware's pattern (here `"*"`)
// until next() returns, but we need the matched route *before* next() so the
// db queries that run inside the handler can pick it up. `routePath(c, -1)`
// from `hono/route` resolves to the last-matched handler's path even when
// called from a middleware position — exactly what @hono/otel uses to name
// its SERVER span.
const httpRouteBaggage: MiddlewareHandler = async (c, next) => {
  const route = routePath(c, -1);
  if (!route || route === "*") {
    return next();
  }
  const current = propagation.getActiveBaggage() ?? propagation.createBaggage();
  const baggage = current.setEntry("http.route", { value: route });
  await otelContext.with(
    propagation.setBaggage(otelContext.active(), baggage),
    () => {
      return next();
    },
  );
};

function shouldCaptureError(error: Error): boolean {
  return !(error instanceof HTTPException) || error.status >= 500;
}

function captureError(error: Error): void {
  if (shouldCaptureError(error)) {
    Sentry.captureException(error);
  }
}

function handleError(error: Error, context: Context): Response {
  if (isAbortError(error)) {
    return context.json({ error: "Internal server error" }, 500);
  }

  captureError(error);

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  L.error("Unhandled request error", error);
  return context.json({ error: "Internal server error" }, 500);
}

interface CreateAppOptions {
  readonly signal: AbortSignal;
  readonly routes?: readonly RouteEntry[];
  // Hook for registering routes that don't fit the ts-rest `RouteEntry`
  // pattern (currently only the WS upgrade endpoint at
  // `/api/zero/voice-chat/relay`). Runs *before* the ts-rest routes so
  // literal paths win over ts-rest contracts that use wildcards (e.g.
  // `/api/zero/voice-chat/:id` would otherwise capture `:id="relay"`).
  // Also runs before `app.notFound(...)`, so the WS path is matched ahead
  // of the legacy-web proxy fallback.
  readonly registerExtraRoutes?: (app: Hono) => void;
}

interface CreateAppWithWebSocketOptions extends CreateAppOptions {
  // Test seam: lets the WS integration test inject an in-memory repository
  // it can introspect and a `ws://127.0.0.1:<port>` OpenAI URL.
  readonly relayRepository?: RelaySessionRepository;
  readonly relayOpenAiUrl?: string;
}

interface AppWithWebSocket {
  readonly app: Hono;
  readonly injectWebSocket: NodeWebSocket["injectWebSocket"];
}

// `createAppWithWebSocket` wires WebSocket support around the standard Hono
// app. Registered WS endpoints (currently only `/api/zero/voice-chat/relay`)
// live outside the ts-rest `ROUTES` array because a WS upgrade does not fit
// the request/response contract validation pattern.
//
// `injectWebSocket` must be called once on the Node HTTP server returned by
// `serve()` in `server.ts`; it attaches a `ws.WebSocketServer` to the
// `upgrade` event so HTTP requests with the WebSocket upgrade header are
// promoted into a WS connection.
export function createAppWithWebSocket(
  options: CreateAppWithWebSocketOptions,
): AppWithWebSocket {
  // The Hono+@hono/node-ws upgrade helper needs the app instance up front
  // (so it can attach the WS upgrade listener via `injectWebSocket` later
  // against the matching ws.WebSocketServer). createApp's `registerExtraRoutes`
  // callback gives us a hook point that runs *before* `notFound` so the WS
  // path wins over the legacy-web proxy fallback.
  let injectWebSocket: NodeWebSocket["injectWebSocket"] | null = null;
  const app = createApp({
    ...options,
    registerExtraRoutes: (a) => {
      const helpers = createNodeWebSocket({ app: a });
      injectWebSocket = helpers.injectWebSocket;
      const repository =
        options.relayRepository ?? createInMemoryRelaySessionRepository();
      const relayOptions: RegisterVoiceChatRelayRouteOptions = {
        app: a,
        upgradeWebSocket: helpers.upgradeWebSocket,
        signal: options.signal,
        repository,
        ...(options.relayOpenAiUrl !== undefined && {
          openAiUrl: options.relayOpenAiUrl,
        }),
      };
      registerVoiceChatRelayRoute(relayOptions);
    },
  });
  if (injectWebSocket === null) {
    throw new Error("createAppWithWebSocket: injectWebSocket missing");
  }
  return { app, injectWebSocket };
}

export function createApp({
  routes = ROUTES,
  signal,
  registerExtraRoutes,
}: CreateAppOptions): Hono {
  const app = new Hono();
  app.onError(handleError);

  // OpenTelemetry: each request gets a SERVER span named after its matched
  // route template (e.g. `GET /api/v1/chat-threads/:threadId`). The baggage
  // middleware then propagates that template down so child spans inherit
  // `http.route` for direct slicing without trace_id joins.
  app.use("*", httpInstrumentationMiddleware({ serviceName: "vm0-api" }));
  app.use("*", httpRouteBaggage);
  // Browser cross-origin requests (e.g. https://app.vm0.ai → api.vm0.ai). Must
  // run before the route handlers so OPTIONS preflight short-circuits without
  // matching a registered method, and so registered route responses receive
  // Access-Control-Allow-Origin without relying on the legacy web proxy.
  app.use("*", corsMiddleware);

  // Flush buffered Axiom logs after the response is sent so logging doesn't
  // add latency to the user-visible request.
  app.use("*", async (c, next) => {
    await next();
    waitUntil(flushLogs());
  });

  // Hook for non-ts-rest routes (currently the WS upgrade endpoint).
  // Registered *before* the ts-rest routes so literal paths win over
  // wildcard ts-rest contracts (e.g. `/api/zero/voice-chat/:id` would
  // otherwise capture `:id="relay"` and route a WS upgrade to the HTTP
  // session-detail handler). Also registered before `notFound` so the
  // legacy-web proxy fallback can't claim these paths.
  if (registerExtraRoutes !== undefined) {
    registerExtraRoutes(app);
  }

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  // Routes that have not been ported off the web app yet still hit api.vm0.ai
  // because the domain is now pointed here. Proxy any request that did not
  // match a registered route to VM0_WEB_URL so legacy traffic keeps working
  // until each endpoint is migrated.
  app.notFound((context) => {
    return proxyToWeb(context, env("VM0_WEB_URL"));
  });

  return app;
}
