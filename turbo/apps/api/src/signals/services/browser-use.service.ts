import { once } from "node:events";

import {
  ZERO_BROWSER_INITIAL_SCREEN_HEIGHT,
  ZERO_BROWSER_SCREEN_WIDTH,
} from "@vm0/api-contracts/contracts/zero-browser";
import { z } from "zod";

import { env } from "../../lib/env";
import {
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
  settle,
} from "../utils";

const BROWSER_USE_API_BASE_URL = "https://api.browser-use.com/api/v3";
const BROWSER_USE_REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_USE_CDP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_BROWSER_USE_RESPONSE_BYTES = 512 * 1024;
const MAX_BROWSER_USE_CDP_RESPONSE_BYTES = 64 * 1024;
const MAX_BROWSER_USE_ERROR_MESSAGE_CHARS = 2048;
const MAX_BROWSER_USE_TAB_URLS = 50;
const MAX_BROWSER_USE_TAB_URL_CHARS = 8192;
const browserUseLiveUrlSchema = z.url().refine((value) => {
  return new URL(value).origin === "https://live.browser-use.com";
});

function isBrowserUseHostname(hostname: string): boolean {
  return (
    hostname === "browser-use.com" || hostname.endsWith(".browser-use.com")
  );
}

const browserUseCdpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && isBrowserUseHostname(url.hostname);
});
const browserUseCdpWebSocketUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "wss:" && isBrowserUseHostname(url.hostname);
});
const browserUseCdpVersionSchema = z.object({
  webSocketDebuggerUrl: z.string().min(1),
});
const browserUseCdpResponseSchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
    })
    .optional(),
});
const browserUseCdpTargetsSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string().min(1),
      type: z.string(),
      url: z.string(),
    }),
  ),
});
const browserUseCdpWindowSchema = z.object({
  windowId: z.number().int().nonnegative(),
});
type BrowserUseCdpSocketEventName = "open" | "message" | "error" | "close";
interface BrowserUseCdpSocketEvent {
  readonly name: BrowserUseCdpSocketEventName;
  readonly event: unknown;
}

const browserUseProfileSchema = z.object({
  id: z.uuid(),
  userId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const browserUseSessionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "stopped"]),
  timeoutAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  liveUrl: browserUseLiveUrlSchema.nullish().transform((value) => {
    return value ?? null;
  }),
  cdpUrl: browserUseCdpUrlSchema.nullish().transform((value) => {
    return value ?? null;
  }),
  finishedAt: z.iso
    .datetime()
    .nullish()
    .transform((value) => {
      return value ?? null;
    }),
});

export type BrowserUseSession = z.infer<typeof browserUseSessionSchema>;

function parseBrowserUseSession(body: unknown): BrowserUseSession {
  return browserUseSessionSchema.parse(body, { reportInput: true });
}

export class BrowserUseProviderError extends Error {
  readonly status: 502 | 503;
  readonly code: string;

  constructor(status: 502 | 503, code: string, message: string) {
    super(message);
    this.name = "BrowserUseProviderError";
    this.status = status;
    this.code = code;
  }
}

function browserUseCdpVersionUrl(cdpUrl: string): URL {
  const url = new URL(browserUseCdpUrlSchema.parse(cdpUrl));
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/json/version`;
  return url;
}

async function browserUseCdpWebSocketUrl(
  cdpUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(browserUseCdpVersionUrl(cdpUrl), { signal });
  const text = await readBoundedResponseText(
    response,
    MAX_BROWSER_USE_CDP_RESPONSE_BYTES,
  );
  if (!response.ok || text.kind === "too_large") {
    throw new Error("Browser Use CDP discovery failed");
  }
  const version = browserUseCdpVersionSchema.parse(safeJsonParse(text.text), {
    reportInput: true,
  });
  return browserUseCdpWebSocketUrlSchema.parse(version.webSocketDebuggerUrl);
}

async function waitForBrowserUseCdpSocketEvent(
  socket: WebSocket,
  name: BrowserUseCdpSocketEventName,
  signal: AbortSignal,
): Promise<BrowserUseCdpSocketEvent> {
  const events: unknown[] = await once(socket, name, { signal });
  signal.throwIfAborted();
  return { name, event: events[0] };
}

async function nextBrowserUseCdpSocketEvent(
  socket: WebSocket,
  names: readonly BrowserUseCdpSocketEventName[],
  signal: AbortSignal,
): Promise<BrowserUseCdpSocketEvent> {
  const controller = new AbortController();
  const result = await settle(
    Promise.race(
      names.map(async (name) => {
        return await waitForBrowserUseCdpSocketEvent(
          socket,
          name,
          AbortSignal.any([signal, controller.signal]),
        );
      }),
    ),
  );
  controller.abort();
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function waitForBrowserUseCdpSocket(
  socket: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  const received = await nextBrowserUseCdpSocketEvent(
    socket,
    ["open", "error", "close"],
    signal,
  );
  if (received.name !== "open") {
    throw new Error("Browser Use CDP connection failed");
  }
}

async function sendBrowserUseCdpCommand(
  socket: WebSocket,
  id: number,
  method: string,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const sent = safeSync(() => {
    socket.send(JSON.stringify({ id, method, params }));
  });
  if ("error" in sent) {
    throw sent.error;
  }
  while (true) {
    const received = await nextBrowserUseCdpSocketEvent(
      socket,
      ["message", "error", "close"],
      signal,
    );
    if (received.name !== "message") {
      throw new Error("Browser Use CDP connection closed");
    }
    if (!(received.event instanceof MessageEvent)) {
      continue;
    }
    if (
      typeof received.event.data !== "string" ||
      received.event.data.length > MAX_BROWSER_USE_CDP_RESPONSE_BYTES
    ) {
      continue;
    }
    const response = browserUseCdpResponseSchema.safeParse(
      safeJsonParse(received.event.data),
    );
    if (!response.success || response.data.id !== id) {
      continue;
    }
    if (response.data.error) {
      throw new Error(response.data.error.message);
    }
    return response.data.result;
  }
}

async function withBrowserUseCdpSocket<T>(
  cdpUrl: string,
  signal: AbortSignal,
  operation: (socket: WebSocket) => Promise<T>,
): Promise<T> {
  const websocketUrl = await browserUseCdpWebSocketUrl(cdpUrl, signal);
  const socket = new WebSocket(websocketUrl);
  const result = await settle(
    (async () => {
      await waitForBrowserUseCdpSocket(socket, signal);
      return await operation(socket);
    })(),
  );
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    safeSync(() => {
      socket.close(1000);
    });
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function resizeBrowserUseCdp(
  cdpUrl: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<void> {
  await withBrowserUseCdpSocket(cdpUrl, signal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        1,
        "Target.getTargets",
        {},
        signal,
      ),
      { reportInput: true },
    );
    const target = targets.targetInfos.find((candidate) => {
      return candidate.type === "page";
    });
    if (!target) {
      throw new Error("Browser Use CDP returned no page target");
    }
    const window = browserUseCdpWindowSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        2,
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
        signal,
      ),
      { reportInput: true },
    );
    await sendBrowserUseCdpCommand(
      socket,
      3,
      "Browser.setContentsSize",
      { windowId: window.windowId, width, height },
      signal,
    );
  });
}

function restorableBrowserUseTabUrl(url: string): boolean {
  if (url.length > MAX_BROWSER_USE_TAB_URL_CHARS || !URL.canParse(url)) {
    return false;
  }
  const protocol = new URL(url).protocol;
  return protocol === "http:" || protocol === "https:";
}

function boundedRestorableBrowserUseTabUrls(
  urls: Iterable<string>,
): readonly string[] {
  const boundedUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const url of urls) {
    if (!restorableBrowserUseTabUrl(url) || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    boundedUrls.push(url);
    if (boundedUrls.length === MAX_BROWSER_USE_TAB_URLS) {
      break;
    }
  }
  return boundedUrls;
}

function browserUseCdpSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(BROWSER_USE_CDP_REQUEST_TIMEOUT_MS),
  ]);
}

export async function listBrowserUseTabUrls(
  cdpUrl: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const cdpSignal = browserUseCdpSignal(signal);
  return await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        1,
        "Target.getTargets",
        {},
        cdpSignal,
      ),
      { reportInput: true },
    );
    return boundedRestorableBrowserUseTabUrls(
      targets.targetInfos
        .filter((target) => {
          return target.type === "page";
        })
        .map((target) => {
          return target.url;
        }),
    );
  });
}

function disposableBrowserUseTabUrl(url: string): boolean {
  return url === "about:blank" || url === "chrome://newtab/";
}

export async function restoreBrowserUseTabUrls(
  cdpUrl: string,
  urls: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const boundedUrls = boundedRestorableBrowserUseTabUrls(urls);
  if (boundedUrls.length === 0) {
    return;
  }
  const cdpSignal = browserUseCdpSignal(signal);
  await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        1,
        "Target.getTargets",
        {},
        cdpSignal,
      ),
      { reportInput: true },
    );
    let commandId = 2;
    let restored = 0;
    for (const url of boundedUrls) {
      const result = await settle(
        sendBrowserUseCdpCommand(
          socket,
          commandId,
          "Target.createTarget",
          { url },
          cdpSignal,
        ),
      );
      commandId += 1;
      signal.throwIfAborted();
      if (result.ok) {
        restored += 1;
      }
    }
    if (restored === 0) {
      throw new Error("Browser Use CDP did not restore any tab");
    }
    for (const target of targets.targetInfos) {
      if (target.type !== "page" || !disposableBrowserUseTabUrl(target.url)) {
        continue;
      }
      await settle(
        sendBrowserUseCdpCommand(
          socket,
          commandId,
          "Target.closeTarget",
          { targetId: target.targetId },
          cdpSignal,
        ),
      );
      commandId += 1;
      signal.throwIfAborted();
    }
  });
}

export async function resizeBrowserUseSession(
  cdpUrl: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await settle(
    resizeBrowserUseCdp(cdpUrl, width, height, browserUseCdpSignal(signal)),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    throw new BrowserUseProviderError(
      502,
      "BROWSER_USE_RESIZE_ERROR",
      "Managed browser provider could not resize the browser",
    );
  }
}

function boundedProviderMessage(message: string): string {
  const normalized = Array.from(message, (character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)
      ? " "
      : character;
  }).join("");
  return normalized.length <= MAX_BROWSER_USE_ERROR_MESSAGE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_BROWSER_USE_ERROR_MESSAGE_CHARS - 3)}...`;
}

function providerMessage(body: unknown): string {
  if (typeof body === "string" && body.trim()) {
    return boundedProviderMessage(body);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Browser Use request failed";
  }
  for (const key of ["detail", "message", "error"] as const) {
    const value = Reflect.get(body, key);
    if (typeof value === "string" && value.trim()) {
      return boundedProviderMessage(value);
    }
  }
  return "Browser Use request failed";
}

function providerError(response: Response, body: unknown) {
  const message = providerMessage(body);
  if (response.status === 401 || response.status === 403) {
    return new BrowserUseProviderError(
      503,
      "BROWSER_USE_AUTH_ERROR",
      "Managed browser provider authentication failed",
    );
  }
  if (response.status === 402 || response.status === 429) {
    return new BrowserUseProviderError(
      503,
      "BROWSER_USE_CAPACITY",
      "Managed browser capacity is temporarily unavailable",
    );
  }
  return new BrowserUseProviderError(
    502,
    "BROWSER_USE_ERROR",
    `Managed browser provider failed: ${message}`,
  );
}

async function browserUseRequest(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  acceptedStatuses: readonly number[] = [],
): Promise<unknown> {
  const apiKey = env("ZERO_BROWSER_USE_API_KEY");
  if (!apiKey) {
    throw new BrowserUseProviderError(
      503,
      "BROWSER_USE_NOT_CONFIGURED",
      "Managed browser provider is not configured",
    );
  }

  const result = await settle(
    (async (): Promise<{ response: Response; body: unknown }> => {
      const response = await fetch(`${BROWSER_USE_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          "X-Browser-Use-API-Key": apiKey,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(BROWSER_USE_REQUEST_TIMEOUT_MS),
        ]),
      });
      const text = await readBoundedResponseText(
        response,
        MAX_BROWSER_USE_RESPONSE_BYTES,
      );
      if (text.kind === "too_large") {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_OUTPUT_TOO_LARGE",
          "Managed browser provider response is too large",
        );
      }
      const body = text.text
        ? (safeJsonParse(text.text) ?? text.text)
        : undefined;
      return { response, body };
    })(),
  );

  if (!result.ok) {
    signal.throwIfAborted();
    if (result.error instanceof BrowserUseProviderError) {
      throw result.error;
    }
    throw new BrowserUseProviderError(
      502,
      "BROWSER_USE_TIMEOUT",
      "Managed browser provider request timed out",
    );
  }

  if (
    !result.value.response.ok &&
    !acceptedStatuses.includes(result.value.response.status)
  ) {
    throw providerError(result.value.response, result.value.body);
  }
  return result.value.body;
}

export async function createBrowserUseProfile(
  chatThreadId: string,
  signal: AbortSignal,
): Promise<string> {
  const body = await browserUseRequest(
    "/profiles",
    {
      method: "POST",
      body: JSON.stringify({
        name: `vm0-browser-profile-${chatThreadId}`,
      }),
    },
    signal,
  );
  return browserUseProfileSchema.parse(body).id;
}

export async function deleteBrowserUseProfile(
  profileId: string,
  signal: AbortSignal,
): Promise<void> {
  await browserUseRequest(
    `/profiles/${encodeURIComponent(profileId)}`,
    { method: "DELETE" },
    signal,
    [404],
  );
}

export async function createBrowserUseSession(
  args: {
    readonly profileId: string;
    readonly proxyCountryCode: string | null;
    readonly timeoutMinutes: number;
  },
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    "/browsers",
    {
      method: "POST",
      body: JSON.stringify({
        profileId: args.profileId,
        proxyCountryCode: args.proxyCountryCode,
        timeout: args.timeoutMinutes,
        browserScreenWidth: ZERO_BROWSER_SCREEN_WIDTH,
        browserScreenHeight: ZERO_BROWSER_INITIAL_SCREEN_HEIGHT,
        allowResizing: true,
        enableRecording: false,
      }),
    },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function getBrowserUseSession(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    { method: "GET" },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function stopBrowserUseSession(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function stopBrowserUseSessionForCleanup(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    },
    signal,
    [404],
  );
}
