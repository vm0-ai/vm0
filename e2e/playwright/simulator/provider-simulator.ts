import { createHmac, randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

const port = requiredIntegerEnvironmentVariable("E2E_PROVIDER_SIMULATOR_PORT");
const controlToken = requiredEnvironmentVariable(
  "E2E_PROVIDER_SIMULATOR_CONTROL_TOKEN",
);
const INITIAL_OAUTH_TOKEN = "oauth-initial-access-token";
const REFRESHED_OAUTH_TOKEN = "oauth-refreshed-access-token";
const OAUTH_REFRESH_TOKEN = "oauth-refresh-token";
const pendingGates = new Map<string, ServerResponse>();
const events: RecordedEvent[] = [];

interface RecordedEvent {
  readonly id: string;
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Simulator failure",
      });
      return;
    }
    response.destroy(error instanceof Error ? error : undefined);
  });
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = await readBody(request);

  if (url.pathname.startsWith("/__control/")) {
    assertControlAuthorization(request);
    await handleControlRequest(request, response, url, body);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  recordEvent("external-request", request, url, body);

  if (url.pathname === "/oauth/authorize") {
    const redirectUri = requiredSearchParameter(url, "redirect_uri");
    const state = requiredSearchParameter(url, "state");
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", "simulator-authorization-code");
    callbackUrl.searchParams.set("state", state);
    response.writeHead(302, { location: callbackUrl.toString() });
    response.end();
    return;
  }

  if (url.pathname === "/oauth/token") {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "refresh_token") {
      sendJson(response, 200, {
        access_token: REFRESHED_OAUTH_TOKEN,
        refresh_token: OAUTH_REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
      });
      return;
    }
    sendJson(response, 200, {
      access_token: INITIAL_OAUTH_TOKEN,
      refresh_token: OAUTH_REFRESH_TOKEN,
      token_type: "Bearer",
      expires_in: 3_600,
    });
    return;
  }

  if (url.pathname.endsWith("/oauth/resource")) {
    if (request.headers.authorization === `Bearer ${INITIAL_OAUTH_TOKEN}`) {
      sendJson(
        response,
        401,
        { error: "invalid_token" },
        { "www-authenticate": 'Bearer error="invalid_token"' },
      );
      return;
    }
    if (request.headers.authorization === `Bearer ${REFRESHED_OAUTH_TOKEN}`) {
      sendJson(response, 200, { ok: true, token: "refreshed" });
      return;
    }
    sendJson(response, 403, { error: "unexpected_token" });
    return;
  }

  if (url.pathname.endsWith("/gate") || url.searchParams.has("gate")) {
    const key = url.searchParams.get("gate") ?? "default";
    const previous = pendingGates.get(key);
    if (previous) {
      sendJson(previous, 409, { error: "gate_replaced" });
    }
    pendingGates.set(key, response);
    response.on("close", () => {
      if (pendingGates.get(key) === response) {
        pendingGates.delete(key);
      }
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    method: request.method ?? "GET",
    path: url.pathname,
  });
}

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  body: string,
): Promise<void> {
  if (url.pathname === "/__control/events") {
    sendJson(response, 200, { events });
    return;
  }
  if (url.pathname === "/__control/reset") {
    events.splice(0, events.length);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__control/release") {
    const key = url.searchParams.get("gate") ?? "default";
    const pending = pendingGates.get(key);
    if (!pending) {
      sendJson(response, 404, { error: "gate_not_found" });
      return;
    }
    pendingGates.delete(key);
    sendJson(pending, 200, { ok: true, released: key });
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/__control/deliver-webhook") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const input = requireRecord(JSON.parse(body), "webhook delivery input");
    const webhookUrl = requireString(input, "url", "webhook delivery input");
    const rawBody = requireString(input, "rawBody", "webhook delivery input");
    const secret = requireString(input, "secret", "webhook delivery input");
    const requestedTimestamp = input.timestamp;
    if (
      requestedTimestamp !== undefined &&
      (typeof requestedTimestamp !== "number" ||
        !Number.isInteger(requestedTimestamp) ||
        requestedTimestamp <= 0)
    ) {
      throw new Error(
        "webhook delivery input.timestamp must be a positive integer",
      );
    }
    const timestamp =
      typeof requestedTimestamp === "number"
        ? requestedTimestamp
        : Math.floor(Date.now() / 1_000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const delivered = await postWebhook(webhookUrl, rawBody, {
      ...parseDeliveryHeaders(input.headers),
      "content-type": "application/json",
      "x-vm0-timestamp": String(timestamp),
      "x-vm0-signature": signature,
    });
    events.push({
      id: randomUUID(),
      kind: "webhook-delivery",
      method: "POST",
      path: new URL(webhookUrl).pathname,
      query: {},
      headers: {},
      body: rawBody,
    });
    sendJson(response, 200, { ...delivered, timestamp });
    return;
  }
  sendJson(response, 404, { error: "control_route_not_found" });
}

function postWebhook(
  rawUrl: string,
  body: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: string }> {
  const url = new URL(rawUrl);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function recordEvent(
  kind: string,
  request: IncomingMessage,
  url: URL,
  body: string,
): void {
  events.push({
    id: randomUUID(),
    kind,
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: normalizedHeaders(request.headers),
    body,
  });
}

function normalizedHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) {
        return [];
      }
      return [[name, Array.isArray(value) ? value.join(", ") : value]];
    }),
  );
}

function assertControlAuthorization(request: IncomingMessage): void {
  if (request.headers["x-control-token"] !== controlToken) {
    throw new Error("Invalid simulator control token");
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function requiredSearchParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing ${name} query parameter`);
  }
  return value;
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function requiredIntegerEnvironmentVariable(name: string): number {
  const rawValue = requiredEnvironmentVariable(name);
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function parseDeliveryHeaders(
  value: unknown,
): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  const record = requireRecord(value, "webhook delivery input.headers");
  return Object.fromEntries(
    Object.keys(record).map((name) => [
      name,
      requireString(record, name, "webhook delivery input.headers"),
    ]),
  );
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${description}.${key} must be a string`);
  }
  return field;
}

server.listen(port, "127.0.0.1", () => {
  console.log(`SIMULATOR_READY http://127.0.0.1:${port}`);
});

function closeServer(): void {
  for (const response of pendingGates.values()) {
    sendJson(response, 503, { error: "simulator_stopping" });
  }
  pendingGates.clear();
  server.close(() => process.exit(0));
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
