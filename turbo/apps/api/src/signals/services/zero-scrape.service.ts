import type {
  ZeroScrapeBillingCategory,
  ZeroScrapeRequest,
  ZeroScrapeResponse,
} from "@vm0/api-contracts/contracts/zero-scrape";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { requestSignal$ } from "../context/hono";
import {
  safeAsync,
  safeJsonParse,
  startUntrackedBestEffortCleanup,
} from "../utils";
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
const FIRECRAWL_PROVIDER_TIMEOUT_MS = 25_000;
const FIRECRAWL_TRANSPORT_TIMEOUT_MS = 30_000;
const MAX_FIRECRAWL_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_MARKDOWN_CHARS = 1_000_000;
const MAX_LINKS = 5000;

const SCRAPE_MODE_CONFIG = {
  standard: {
    firecrawlProxy: "basic",
    billingCategories: {
      markdown: "standard.markdown",
      links: "standard.links",
    },
  },
  enhanced: {
    firecrawlProxy: "enhanced",
    billingCategories: {
      markdown: "enhanced.markdown",
      links: "enhanced.links",
    },
  },
} as const satisfies Record<
  ZeroScrapeRequest["mode"],
  {
    readonly firecrawlProxy: "basic" | "enhanced";
    readonly billingCategories: Record<
      ZeroScrapeRequest["format"],
      ZeroScrapeBillingCategory
    >;
  }
>;

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

interface ScrapeErrorResult {
  readonly kind: "error";
  readonly error: ScrapeErrorResponse;
}

type FirecrawlTextResult =
  | ScrapeErrorResult
  | { readonly kind: "text"; readonly text: string };

type FirecrawlBodyResult =
  | ScrapeErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type FirecrawlResponseResult =
  | ScrapeErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface FirecrawlScrapeData {
  readonly markdown?: string;
  readonly links?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

interface NormalizedScrapeBase {
  readonly metadata?: ZeroScrapeResponse["metadata"];
  readonly finalUrl?: string;
}

type NormalizedScrape = NormalizedScrapeBase &
  (
    | {
        readonly format: "markdown";
        readonly result: { readonly markdown: string };
      }
    | {
        readonly format: "links";
        readonly result: { readonly links: string[] };
      }
  );

interface ZeroScrapeSuccessArgs {
  readonly request: ZeroScrapeRequest;
  readonly requestedUrl: URL;
  readonly normalized: NormalizedScrape;
  readonly creditsCharged: number;
}

interface ZeroScrapeSuccessBase {
  readonly requestedUrl: string;
  readonly finalUrl?: string;
  readonly provider: "firecrawl";
  readonly creditsCharged: number;
  readonly billingQuantity: number;
  readonly metadata?: ZeroScrapeResponse["metadata"];
}

type ZeroScrapeCommandResponse =
  | { readonly status: 200; readonly body: ZeroScrapeResponse }
  | ScrapeErrorResponse
  | ManagedUsageErrorResponse;

interface CompleteScrapeSuccessArgs {
  readonly request: ZeroScrapeRequest;
  readonly requestedUrl: URL;
  readonly firecrawlResult: FirecrawlBodyResult;
  readonly recordUsage: () => Promise<number>;
}

interface CompleteScrapeAfterProviderArgs {
  readonly apiKey: string;
  readonly request: ZeroScrapeRequest;
  readonly requestedUrl: URL;
  readonly recordUsage: () => Promise<number>;
  readonly signal: AbortSignal;
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

function billingCategory(args: ZeroScrapeRequest): ZeroScrapeBillingCategory {
  return SCRAPE_MODE_CONFIG[args.mode].billingCategories[args.format];
}

function firecrawlProxy(mode: ZeroScrapeRequest["mode"]): "basic" | "enhanced" {
  return SCRAPE_MODE_CONFIG[mode].firecrawlProxy;
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

function firecrawlFailure(body: unknown): ScrapeErrorResponse | null {
  return isRecord(body) && body.success === false
    ? badGateway(firecrawlErrorMessage(body))
    : null;
}

function scrapeErrorResult(error: ScrapeErrorResponse): ScrapeErrorResult {
  return { kind: "error", error };
}

function oversizedFirecrawlResponse(): ScrapeErrorResponse {
  return badGateway(
    "Firecrawl scrape response is too large",
    "SCRAPE_OUTPUT_TOO_LARGE",
  );
}

function startBestEffortCancel(cancel: Promise<unknown>): void {
  // Stream cancellation is advisory. Some stream implementations never settle
  // the cancel promise, so do not put it in the detached-promise drain.
  startUntrackedBestEffortCleanup(cancel);
}

function contentLengthExceedsLimit(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) {
    return false;
  }

  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > MAX_FIRECRAWL_RESPONSE_BYTES;
}

function startResponseBodyCancel(body: ReadableStream<Uint8Array> | null) {
  if (!body) {
    return;
  }
  startBestEffortCancel(body.cancel());
}

async function readResponseText(
  response: Response,
): Promise<FirecrawlTextResult> {
  if (contentLengthExceedsLimit(response)) {
    startResponseBodyCancel(response.body);
    return scrapeErrorResult(oversizedFirecrawlResponse());
  }

  if (!response.body) {
    return { kind: "text", text: "" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    if (bytesRead > MAX_FIRECRAWL_RESPONSE_BYTES) {
      startBestEffortCancel(reader.cancel());
      return scrapeErrorResult(oversizedFirecrawlResponse());
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return { kind: "text", text: chunks.join("") };
}

async function readResponseBody(
  response: Response,
): Promise<FirecrawlBodyResult> {
  const result = await readResponseText(response);
  if (result.kind === "error") {
    return result;
  }
  const { text } = result;
  if (!text) {
    return { kind: "body", body: null };
  }
  const parsed = safeJsonParse(text);
  return { kind: "body", body: parsed === undefined ? text : parsed };
}

async function fetchFirecrawlScrape(
  apiKey: string,
  request: ZeroScrapeRequest,
  targetUrl: URL,
  signal: AbortSignal,
): Promise<FirecrawlBodyResult> {
  const result = await safeAsync(async (): Promise<FirecrawlResponseResult> => {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: targetUrl.toString(),
        formats: [request.format],
        parsers: [],
        proxy: firecrawlProxy(request.mode),
        skipTlsVerification: false,
        maxAge: 0,
        storeInCache: false,
        timeout: FIRECRAWL_PROVIDER_TIMEOUT_MS,
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(FIRECRAWL_TRANSPORT_TIMEOUT_MS),
      ]),
    });

    const readResult = await readResponseBody(response);
    if (readResult.kind === "error") {
      return readResult;
    }
    return { kind: "response", response, body: readResult.body };
  });

  if ("error" in result) {
    const { error } = result;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return scrapeErrorResult(
        badGateway("Firecrawl scrape request timed out", "FIRECRAWL_TIMEOUT"),
      );
    }
    return scrapeErrorResult(badGateway("Firecrawl scrape request failed"));
  }

  if (result.ok.kind === "error") {
    return result.ok;
  }

  const { response, body } = result.ok;
  if (!response.ok) {
    return scrapeErrorResult(badGateway(firecrawlErrorMessage(body)));
  }
  return { kind: "body", body };
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
    optionalString(metadata, "url") ??
    optionalString(metadata, "sourceURL") ??
    optionalString(metadata, "sourceUrl")
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
      format: "markdown",
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
    format: "links",
    result: { links: [...data.links] },
    metadata: normalizeMetadata(data.metadata),
    ...(finalUrl ? { finalUrl } : {}),
  };
}

function successResponseBase(
  args: ZeroScrapeSuccessArgs,
): ZeroScrapeSuccessBase {
  return {
    requestedUrl: args.requestedUrl.toString(),
    ...(args.normalized.finalUrl ? { finalUrl: args.normalized.finalUrl } : {}),
    provider: PROVIDER,
    creditsCharged: args.creditsCharged,
    billingQuantity: 1,
    ...(args.normalized.metadata ? { metadata: args.normalized.metadata } : {}),
  };
}

function standardSuccessBody(
  base: ZeroScrapeSuccessBase,
  normalized: NormalizedScrape,
): ZeroScrapeResponse {
  switch (normalized.format) {
    case "markdown": {
      return {
        ...base,
        format: "markdown",
        mode: "standard",
        billingCategory: SCRAPE_MODE_CONFIG.standard.billingCategories.markdown,
        result: normalized.result,
      };
    }
    case "links": {
      return {
        ...base,
        format: "links",
        mode: "standard",
        billingCategory: SCRAPE_MODE_CONFIG.standard.billingCategories.links,
        result: normalized.result,
      };
    }
  }
}

function enhancedSuccessBody(
  base: ZeroScrapeSuccessBase,
  normalized: NormalizedScrape,
): ZeroScrapeResponse {
  switch (normalized.format) {
    case "markdown": {
      return {
        ...base,
        format: "markdown",
        mode: "enhanced",
        billingCategory: SCRAPE_MODE_CONFIG.enhanced.billingCategories.markdown,
        result: normalized.result,
      };
    }
    case "links": {
      return {
        ...base,
        format: "links",
        mode: "enhanced",
        billingCategory: SCRAPE_MODE_CONFIG.enhanced.billingCategories.links,
        result: normalized.result,
      };
    }
  }
}

function successBody(args: ZeroScrapeSuccessArgs): ZeroScrapeResponse {
  const base = successResponseBase(args);
  switch (args.request.mode) {
    case "standard": {
      return standardSuccessBody(base, args.normalized);
    }
    case "enhanced": {
      return enhancedSuccessBody(base, args.normalized);
    }
  }
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

async function completeScrapeSuccess(
  args: CompleteScrapeSuccessArgs,
): Promise<ZeroScrapeCommandResponse> {
  if (args.firecrawlResult.kind === "error") {
    return args.firecrawlResult.error;
  }
  const { body: firecrawlBody } = args.firecrawlResult;

  const firecrawlFailureResponse = firecrawlFailure(firecrawlBody);
  if (firecrawlFailureResponse) {
    return firecrawlFailureResponse;
  }

  const firecrawlData = dataFromFirecrawlBody(firecrawlBody);
  if (!firecrawlData) {
    return badGateway("Firecrawl response did not include scrape data");
  }

  const normalized = normalizeFirecrawlData(args.request, firecrawlData);
  if (isScrapeErrorResponse(normalized)) {
    return normalized;
  }

  const finalUrlError = await validateFinalUrl(normalized.finalUrl);
  if (finalUrlError) {
    return finalUrlError;
  }

  const creditsCharged = await args.recordUsage();
  const body = successBody({
    request: args.request,
    requestedUrl: args.requestedUrl,
    normalized,
    creditsCharged,
  });
  return { status: 200 as const, body };
}

async function completeScrapeAfterProvider(
  args: CompleteScrapeAfterProviderArgs,
): Promise<ZeroScrapeCommandResponse> {
  const firecrawlResult = await fetchFirecrawlScrape(
    args.apiKey,
    args.request,
    args.requestedUrl,
    args.signal,
  );

  return await completeScrapeSuccess({
    request: args.request,
    requestedUrl: args.requestedUrl,
    firecrawlResult,
    recordUsage: args.recordUsage,
  });
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
    { get, set },
    args: AuthedScrapeArgs,
    signal: AbortSignal,
  ): Promise<ZeroScrapeCommandResponse> => {
    const apiKey = env("ZERO_SCRAPE_FIRECRAWL_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Zero Scrape Firecrawl provider is not configured",
        "NOT_CONFIGURED",
      );
    }
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();

    const target = await validateScrapeTargetUrl(args.body.url);
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
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
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completeScrapeAfterProvider({
      apiKey,
      request: args.body,
      requestedUrl: target.url,
      signal: requestSignal,
      recordUsage: () => {
        return set(
          recordManagedUsage$,
          {
            actor: {
              orgId: args.auth.orgId,
              userId: args.auth.userId,
              ...(runId ? { runId } : {}),
            },
            resource: {
              kind: USAGE_KIND,
              provider: PROVIDER,
              category,
            },
            label: "scrape",
          },
          requestSignal,
        );
      },
    });
  },
);
