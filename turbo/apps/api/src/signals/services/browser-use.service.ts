import { z } from "zod";

import { env } from "../../lib/env";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";

const BROWSER_USE_API_BASE_URL = "https://api.browser-use.com/api/v3";
const BROWSER_USE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BROWSER_USE_RESPONSE_BYTES = 512 * 1024;
const MAX_BROWSER_USE_ERROR_MESSAGE_CHARS = 2048;
const browserUseLiveUrlSchema = z.url().refine((value) => {
  return new URL(value).origin === "https://live.browser-use.com";
});
const browserUseCdpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    (url.hostname === "browser-use.com" ||
      url.hostname.endsWith(".browser-use.com"))
  );
});

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

  if (!result.value.response.ok) {
    throw providerError(result.value.response, result.value.body);
  }
  return result.value.body;
}

export async function createBrowserUseProfile(
  browserProfileId: string,
  signal: AbortSignal,
): Promise<string> {
  const body = await browserUseRequest(
    "/profiles",
    {
      method: "POST",
      body: JSON.stringify({
        name: `vm0-browser-profile-${browserProfileId}`,
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
        browserScreenWidth: 1440,
        browserScreenHeight: 900,
        allowResizing: false,
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
