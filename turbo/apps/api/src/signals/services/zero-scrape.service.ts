import type {
  ZeroScrapeRequest,
  ZeroScrapeResponse,
} from "@vm0/api-contracts/contracts/zero-scrape";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { safeAsync, safeJsonParse } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./zero-managed-usage.service";
import {
  validateScrapeTargetUrl,
  type ScrapeTargetPolicyError,
} from "./zero-scrape-target-policy";

const PROVIDER = "firecrawl";
const USAGE_KIND = "scrape";
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_TIMEOUT_MS = 30_000;
const MAX_MARKDOWN_CHARS = 1_000_000;
const MAX_LINKS = 5000;

type ErrorStatus = 400 | 402 | 502 | 503;

interface ScrapeErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface AuthedScrapeArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: ZeroScrapeRequest;
}

interface FirecrawlScrapeData {
  readonly markdown?: string;
  readonly links?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

interface NormalizedScrape {
  readonly result: ZeroScrapeResponse["result"];
  readonly metadata?: ZeroScrapeResponse["metadata"];
  readonly finalUrl?: string;
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badRequest(
  message: string,
  code = "BAD_REQUEST",
): ScrapeErrorResponse {
  return { status: 400, body: errorBody(message, code) };
}

function badGateway(message: string, code = "FIRECRAWL_ERROR") {
  return { status: 502 as const, body: errorBody(message, code) };
}

function serviceUnavailable(
  message: string,
  code: string,
): ScrapeErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function billingCategory(args: ZeroScrapeRequest): string {
  return `${args.mode}.${args.format}`;
}

function firecrawlProxy(mode: ZeroScrapeRequest["mode"]): "basic" | "enhanced" {
  return mode === "enhanced" ? "enhanced" : "basic";
}

function targetPolicyMessage(error: ScrapeTargetPolicyError): string {
  switch (error) {
    case "invalid_url": {
      return "Scrape URL is invalid";
    }
    case "unsupported_scheme": {
      return "Scrape URL must use http or https";
    }
    case "embedded_credentials": {
      return "Scrape URL must not include credentials";
    }
    case "internal_hostname": {
      return "Scrape URL must target a public hostname";
    }
    case "unresolvable_hostname": {
      return "Scrape URL hostname could not be resolved";
    }
    case "blocked_address": {
      return "Scrape URL resolves to a blocked network address";
    }
  }
}

function firecrawlErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.error === "string") {
      return body.error;
    }
    if (typeof body.message === "string") {
      return body.message;
    }
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return "Firecrawl scrape request failed";
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

async function fetchFirecrawlScrape(
  apiKey: string,
  request: ZeroScrapeRequest,
  targetUrl: URL,
  signal: AbortSignal,
): Promise<unknown | ScrapeErrorResponse> {
  const result = await safeAsync(async () => {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: targetUrl.toString(),
        formats: [request.format],
        proxy: firecrawlProxy(request.mode),
        skipTlsVerification: false,
        storeInCache: false,
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      ]),
    });

    const body = await readResponseBody(response);
    return { response, body };
  });

  if ("error" in result) {
    signal.throwIfAborted();
    const { error } = result;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return badGateway(
        "Firecrawl scrape request timed out",
        "FIRECRAWL_TIMEOUT",
      );
    }
    return badGateway("Firecrawl scrape request failed");
  }

  const { response, body } = result.ok;
  if (!response.ok) {
    return badGateway(firecrawlErrorMessage(body));
  }
  return body;
}

function dataFromFirecrawlBody(body: unknown): FirecrawlScrapeData | null {
  if (!isRecord(body) || !isRecord(body.data)) {
    return null;
  }

  const data = body.data;
  return {
    ...(typeof data.markdown === "string" ? { markdown: data.markdown } : {}),
    ...(Array.isArray(data.links) &&
    data.links.every((link) => {
      return typeof link === "string";
    })
      ? { links: data.links }
      : {}),
    ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
  };
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalInteger(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = optionalNumber(source, key);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
): ZeroScrapeResponse["metadata"] {
  if (!metadata) {
    return undefined;
  }

  const normalized = {
    title: optionalString(metadata, "title"),
    description: optionalString(metadata, "description"),
    language: optionalString(metadata, "language"),
    statusCode: optionalInteger(metadata, "statusCode"),
    publishedTime: optionalString(metadata, "publishedTime"),
  };

  return Object.values(normalized).some((value) => {
    return value !== undefined;
  })
    ? normalized
    : undefined;
}

function metadataFinalUrl(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  return (
    optionalString(metadata, "sourceURL") ??
    optionalString(metadata, "sourceUrl") ??
    optionalString(metadata, "url")
  );
}

function normalizeFirecrawlData(
  request: ZeroScrapeRequest,
  data: FirecrawlScrapeData,
): NormalizedScrape | ScrapeErrorResponse {
  const finalUrl = metadataFinalUrl(data.metadata);

  if (request.format === "markdown") {
    if (typeof data.markdown !== "string") {
      return badGateway("Firecrawl response did not include markdown");
    }
    if (data.markdown.length > MAX_MARKDOWN_CHARS) {
      return badGateway(
        "Firecrawl markdown output is too large",
        "SCRAPE_OUTPUT_TOO_LARGE",
      );
    }
    return {
      result: { markdown: data.markdown },
      metadata: normalizeMetadata(data.metadata),
      ...(finalUrl ? { finalUrl } : {}),
    };
  }

  if (!data.links) {
    return badGateway("Firecrawl response did not include links");
  }
  if (data.links.length > MAX_LINKS) {
    return badGateway(
      "Firecrawl links output is too large",
      "SCRAPE_OUTPUT_TOO_LARGE",
    );
  }
  return {
    result: { links: [...data.links] },
    metadata: normalizeMetadata(data.metadata),
    ...(finalUrl ? { finalUrl } : {}),
  };
}

async function validateFinalUrl(
  finalUrl: string | undefined,
): Promise<ScrapeErrorResponse | null> {
  if (!finalUrl) {
    return null;
  }
  const validation = await validateScrapeTargetUrl(finalUrl);
  return typeof validation === "string"
    ? badGateway(
        "Firecrawl returned a non-public final URL",
        "UNSAFE_FINAL_URL",
      )
    : null;
}

function isScrapeErrorResponse(value: unknown): value is ScrapeErrorResponse {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}

export const zeroScrape$ = command(
  async (
    { set },
    args: AuthedScrapeArgs,
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: ZeroScrapeResponse }
    | ScrapeErrorResponse
    | ManagedUsageErrorResponse
  > => {
    const apiKey = env("ZERO_SCRAPE_FIRECRAWL_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Scrape Firecrawl provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const target = await validateScrapeTargetUrl(args.body.url);
    signal.throwIfAborted();
    if (typeof target === "string") {
      return badRequest(targetPolicyMessage(target), "INVALID_SCRAPE_TARGET");
    }

    const category = billingCategory(args.body);
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category,
        },
        label: "Zero Scrape",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const firecrawlBody = await fetchFirecrawlScrape(
      apiKey,
      args.body,
      target.url,
      signal,
    );
    signal.throwIfAborted();
    if (isScrapeErrorResponse(firecrawlBody)) {
      return firecrawlBody;
    }

    const firecrawlData = dataFromFirecrawlBody(firecrawlBody);
    if (!firecrawlData) {
      return badGateway("Firecrawl response did not include scrape data");
    }

    const normalized = normalizeFirecrawlData(args.body, firecrawlData);
    if (isScrapeErrorResponse(normalized)) {
      return normalized;
    }

    const finalUrlError = await validateFinalUrl(normalized.finalUrl);
    signal.throwIfAborted();
    if (finalUrlError) {
      return finalUrlError;
    }

    const creditsCharged = await set(
      recordManagedUsage$,
      {
        actor: {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          ...(runIdForUsage(args.auth)
            ? { runId: runIdForUsage(args.auth) }
            : {}),
        },
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category,
        },
        label: "scrape",
      },
      signal,
    );

    const body: ZeroScrapeResponse = {
      requestedUrl: target.url.toString(),
      ...(normalized.finalUrl ? { finalUrl: normalized.finalUrl } : {}),
      format: args.body.format,
      mode: args.body.mode,
      provider: PROVIDER,
      creditsCharged,
      billingCategory: category,
      billingQuantity: 1,
      result: normalized.result,
      ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
    };
    return { status: 200 as const, body };
  },
);
