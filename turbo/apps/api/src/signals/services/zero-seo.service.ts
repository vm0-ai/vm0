import type {
  ZeroSeoBacklinksSummaryRequest,
  ZeroSeoEngine,
  ZeroSeoKeywordIdeasRequest,
  ZeroSeoRankedKeywordsRequest,
  ZeroSeoResponse,
  ZeroSeoSerpRequest,
} from "@vm0/api-contracts/contracts/zero-seo";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./zero-managed-usage.service";

const USAGE_KIND = "seo";
const DATAFORSEO_PROVIDER = "dataforseo";
const SERPAPI_PROVIDER = "serpapi";
const DATAFORSEO_BILLING_CATEGORY = "provider_cost_usd_micros";
const SERPAPI_BILLING_CATEGORY = "search";
const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
const SERPAPI_GOOGLE_MAPS_DEFAULT_ZOOM = 14;
const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_ERROR_MESSAGE_CHARS = 4096;
const MICRO_USD_PER_USD = 1_000_000;

type SeoRequest =
  | { readonly operation: "serp"; readonly body: ZeroSeoSerpRequest }
  | {
      readonly operation: "keyword-ideas";
      readonly body: ZeroSeoKeywordIdeasRequest;
    }
  | {
      readonly operation: "ranked-keywords";
      readonly body: ZeroSeoRankedKeywordsRequest;
    }
  | {
      readonly operation: "backlinks-summary";
      readonly body: ZeroSeoBacklinksSummaryRequest;
    };

type DataForSeoSerpEngine = Exclude<ZeroSeoEngine, "google_shopping">;

const DATAFORSEO_SERP_PATHS: Readonly<Record<DataForSeoSerpEngine, string>> = {
  google: "/v3/serp/google/organic/live/advanced",
  bing: "/v3/serp/bing/organic/live/advanced",
  google_maps: "/v3/serp/google/maps/live/advanced",
  google_news: "/v3/serp/google/news/live/advanced",
};

type DataForSeoRequest =
  | Exclude<SeoRequest, { readonly operation: "serp" }>
  | {
      readonly operation: "serp";
      readonly body: ZeroSeoSerpRequest & {
        readonly provider: "dataforseo";
        readonly engine: DataForSeoSerpEngine;
      };
    };

interface AuthedSeoArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly request: SeoRequest;
}

type ErrorStatus = 502 | 503;

interface SeoErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface SeoErrorResult {
  readonly kind: "error";
  readonly error: SeoErrorResponse;
}

type ProviderBodyResult =
  | SeoErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type DataForSeoBodyResult =
  | SeoErrorResult
  | {
      readonly kind: "body";
      readonly body: unknown;
      readonly providerCostUsd: number;
      readonly billingQuantity: number;
    };

type SerpApiBodyResult =
  | SeoErrorResult
  | {
      readonly kind: "body";
      readonly body: unknown;
      readonly cached: boolean;
    };

type ZeroSeoCommandResponse =
  | { readonly status: 200; readonly body: ZeroSeoResponse }
  | SeoErrorResponse
  | ManagedUsageErrorResponse;

const dataForSeoTaskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nonnegative(),
});

const dataForSeoResponseSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nonnegative(),
  tasks_error: z.number().int().nonnegative(),
  tasks: z.array(dataForSeoTaskSchema).max(1),
});

const serpApiResponseSchema = z.object({
  search_metadata: z.object({
    status: z.string(),
    created_at: z.string().optional(),
  }),
  error: z.string().optional(),
});

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(
  message: string,
  code = "SEO_PROVIDER_ERROR",
): SeoErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(message: string): SeoErrorResponse {
  return { status: 503, body: errorBody(message, "NOT_CONFIGURED") };
}

function errorResult(error: SeoErrorResponse): SeoErrorResult {
  return { kind: "error", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedErrorMessage(message: string): string {
  const sanitized = Array.from(message, (character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)
      ? " "
      : character;
  }).join("");
  return sanitized.length <= MAX_PROVIDER_ERROR_MESSAGE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARS - 3)}...`;
}

function parseResponseText(text: string): unknown {
  if (!text) {
    return null;
  }
  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

async function fetchProviderJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  providerName: string,
): Promise<ProviderBodyResult> {
  const result = await settle(
    (async () => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        ]),
      });
      const textResult = await readBoundedResponseText(
        response,
        MAX_PROVIDER_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            `${providerName} SEO response is too large`,
            "SEO_OUTPUT_TOO_LARGE",
          ),
        );
      }

      const body = parseResponseText(textResult.text);
      if (response.status === 429) {
        return errorResult(
          badGateway(
            `${providerName} is temporarily rate limited`,
            "SEO_PROVIDER_RATE_LIMITED",
          ),
        );
      }
      if (!response.ok) {
        return errorResult(badGateway(`${providerName} SEO request failed`));
      }
      return { kind: "body" as const, body };
    })(),
  );

  if (!result.ok) {
    if (
      result.error instanceof Error &&
      (result.error.name === "AbortError" ||
        result.error.name === "TimeoutError")
    ) {
      return errorResult(
        badGateway(`${providerName} SEO request timed out`, "SEO_TIMEOUT"),
      );
    }
    return errorResult(badGateway(`${providerName} SEO request failed`));
  }
  return result.value;
}

function dataForSeoPath(request: DataForSeoRequest): string {
  switch (request.operation) {
    case "serp": {
      return DATAFORSEO_SERP_PATHS[request.body.engine];
    }
    case "keyword-ideas": {
      return "/v3/dataforseo_labs/keyword_ideas/live";
    }
    case "ranked-keywords": {
      return "/v3/dataforseo_labs/ranked_keywords/live";
    }
    case "backlinks-summary": {
      return "/v3/backlinks/summary/live";
    }
  }
}

function dataForSeoTask(request: DataForSeoRequest): Record<string, unknown> {
  switch (request.operation) {
    case "serp": {
      return {
        keyword: request.body.query,
        location_name: request.body.location,
        language_code: request.body.languageCode,
        ...(request.body.engine === "google_news"
          ? {}
          : { device: request.body.device }),
        depth: request.body.limit,
      };
    }
    case "keyword-ideas": {
      return {
        keywords: [request.body.keyword],
        location_name: request.body.location,
        language_code: request.body.languageCode,
        limit: request.body.limit,
      };
    }
    case "ranked-keywords": {
      return {
        target: request.body.target,
        location_name: request.body.location,
        language_code: request.body.languageCode,
        limit: request.body.limit,
      };
    }
    case "backlinks-summary": {
      return {
        target: request.body.target,
        include_subdomains: request.body.includeSubdomains,
      };
    }
  }
}

function dataForSeoPreflightQuantity(request: DataForSeoRequest): number {
  switch (request.operation) {
    case "serp": {
      const resultsPerPage = request.body.engine === "google_maps" ? 100 : 10;
      return 2000 * Math.ceil(request.body.limit / resultsPerPage);
    }
    case "keyword-ideas":
    case "ranked-keywords": {
      return 12_000 + 120 * request.body.limit;
    }
    case "backlinks-summary": {
      return 24_000;
    }
  }
}

function providerCostMicros(costUsd: number): number | undefined {
  const quantity = Math.ceil(costUsd * MICRO_USD_PER_USD);
  return Number.isSafeInteger(quantity) ? quantity : undefined;
}

async function fetchDataForSeo(
  login: string,
  password: string,
  request: DataForSeoRequest,
  signal: AbortSignal,
): Promise<DataForSeoBodyResult> {
  const result = await fetchProviderJson(
    new URL(dataForSeoPath(request), DATAFORSEO_BASE_URL),
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([dataForSeoTask(request)]),
    },
    signal,
    "DataForSEO",
  );
  if (result.kind === "error") {
    return result;
  }

  const parsed = dataForSeoResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return errorResult(
      badGateway(
        "DataForSEO returned an invalid response",
        "DATAFORSEO_INVALID_RESPONSE",
      ),
    );
  }
  const task = parsed.data.tasks[0];
  if (
    parsed.data.status_code !== 20_000 ||
    parsed.data.tasks_error !== 0 ||
    !task ||
    task.status_code !== 20_000
  ) {
    return errorResult(
      badGateway(
        sanitizedErrorMessage(
          task?.status_message ?? parsed.data.status_message,
        ),
        "DATAFORSEO_ERROR",
      ),
    );
  }
  const billingQuantity = providerCostMicros(parsed.data.cost);
  if (billingQuantity === undefined) {
    return errorResult(
      badGateway(
        "DataForSEO returned an invalid cost",
        "DATAFORSEO_INVALID_RESPONSE",
      ),
    );
  }
  return {
    kind: "body",
    body: result.body,
    providerCostUsd: parsed.data.cost,
    billingQuantity,
  };
}

function serpApiUrl(apiKey: string, request: ZeroSeoSerpRequest): URL {
  const url = new URL(SERPAPI_SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("engine", request.engine);
  url.searchParams.set("q", request.query);
  url.searchParams.set("location", request.location);
  url.searchParams.set("no_cache", "false");
  if (request.engine === "bing") {
    url.searchParams.set("cc", request.countryCode);
    url.searchParams.set("setlang", request.languageCode);
    url.searchParams.set("count", String(request.limit));
  } else {
    url.searchParams.set("gl", request.countryCode);
    url.searchParams.set("hl", request.languageCode);
    if (request.engine === "google_maps") {
      url.searchParams.set("z", String(SERPAPI_GOOGLE_MAPS_DEFAULT_ZOOM));
    } else if (request.engine === "google") {
      url.searchParams.set("device", request.device);
      url.searchParams.set("num", String(request.limit));
    }
  }
  return url;
}

function isSerpApiCacheHit(
  createdAt: string | undefined,
  requestStartedAt: number,
): boolean {
  if (!createdAt) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return createdAtMs < Math.floor(requestStartedAt / 1000) * 1000;
}

function stripSerpApiKey(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.search_parameters)) {
    return body;
  }
  return {
    ...body,
    search_parameters: Object.fromEntries(
      Object.entries(body.search_parameters).filter(([key]) => {
        return key !== "api_key";
      }),
    ),
  };
}

async function fetchSerpApi(
  apiKey: string,
  request: ZeroSeoSerpRequest,
  signal: AbortSignal,
): Promise<SerpApiBodyResult> {
  const requestStartedAt = now();
  const result = await fetchProviderJson(
    serpApiUrl(apiKey, request),
    { method: "GET" },
    signal,
    "SerpAPI",
  );
  if (result.kind === "error") {
    return result;
  }

  const parsed = serpApiResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return errorResult(
      badGateway(
        "SerpAPI returned an invalid response",
        "SERPAPI_INVALID_RESPONSE",
      ),
    );
  }
  if (parsed.data.search_metadata.status !== "Success") {
    return errorResult(
      badGateway(
        sanitizedErrorMessage(
          parsed.data.error ?? "SerpAPI could not complete the search",
        ),
        "SERPAPI_ERROR",
      ),
    );
  }
  return {
    kind: "body",
    body: stripSerpApiKey(result.body),
    cached: isSerpApiCacheHit(
      parsed.data.search_metadata.created_at,
      requestStartedAt,
    ),
  };
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "zero" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

function usageActor(auth: AuthContext & { readonly orgId: string }) {
  const runId = runIdForUsage(auth);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    ...(runId ? { runId } : {}),
  };
}

function dataForSeoRequest(request: SeoRequest): DataForSeoRequest | undefined {
  if (request.operation !== "serp") {
    return request;
  }
  if (
    request.body.provider !== "dataforseo" ||
    request.body.engine === "google_shopping"
  ) {
    return undefined;
  }
  return {
    operation: "serp",
    body: {
      ...request.body,
      provider: "dataforseo",
      engine: request.body.engine,
    },
  };
}

const runDataForSeo$ = command(
  async (
    { get, set },
    args: AuthedSeoArgs & { readonly request: DataForSeoRequest },
    signal: AbortSignal,
  ): Promise<ZeroSeoCommandResponse> => {
    const login = env("ZERO_SEO_DATAFORSEO_LOGIN");
    const password = env("ZERO_SEO_DATAFORSEO_PASSWORD");
    if (!login || !password) {
      return serviceUnavailable(
        "Zero SEO DataForSEO provider is not configured",
      );
    }

    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: USAGE_KIND,
          provider: DATAFORSEO_PROVIDER,
          category: DATAFORSEO_BILLING_CATEGORY,
          quantity: dataForSeoPreflightQuantity(args.request),
        },
        label: "Zero SEO DataForSEO",
      },
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const providerResult = await fetchDataForSeo(
      login,
      password,
      args.request,
      providerSignal,
    );
    signal.throwIfAborted();
    if (providerResult.kind === "error") {
      return providerResult.error;
    }

    const creditsCharged =
      providerResult.billingQuantity === 0
        ? 0
        : await set(
            recordManagedUsage$,
            {
              actor: usageActor(args.auth),
              resource: {
                kind: USAGE_KIND,
                provider: DATAFORSEO_PROVIDER,
                category: DATAFORSEO_BILLING_CATEGORY,
                quantity: providerResult.billingQuantity,
              },
              label: "SEO DataForSEO",
            },
            signal,
          );
    return {
      status: 200,
      body: {
        operation: args.request.operation,
        provider: DATAFORSEO_PROVIDER,
        billingCategory: DATAFORSEO_BILLING_CATEGORY,
        billingQuantity: providerResult.billingQuantity,
        providerCostUsd: providerResult.providerCostUsd,
        creditsCharged,
        result: providerResult.body,
      },
    };
  },
);

const runSerpApi$ = command(
  async (
    { get, set },
    args: AuthedSeoArgs & {
      readonly request: {
        readonly operation: "serp";
        readonly body: ZeroSeoSerpRequest & { readonly provider: "serpapi" };
      };
    },
    signal: AbortSignal,
  ): Promise<ZeroSeoCommandResponse> => {
    const apiKey = env("ZERO_SEO_SERPAPI_TOKEN");
    if (!apiKey) {
      return serviceUnavailable("Zero SEO SerpAPI provider is not configured");
    }

    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          kind: USAGE_KIND,
          provider: SERPAPI_PROVIDER,
          category: SERPAPI_BILLING_CATEGORY,
        },
        label: "Zero SEO SerpAPI",
      },
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const providerResult = await fetchSerpApi(
      apiKey,
      args.request.body,
      providerSignal,
    );
    signal.throwIfAborted();
    if (providerResult.kind === "error") {
      return providerResult.error;
    }

    const creditsCharged = providerResult.cached
      ? 0
      : await set(
          recordManagedUsage$,
          {
            actor: usageActor(args.auth),
            resource: {
              kind: USAGE_KIND,
              provider: SERPAPI_PROVIDER,
              category: SERPAPI_BILLING_CATEGORY,
            },
            label: "SEO SerpAPI",
          },
          signal,
        );
    return {
      status: 200,
      body: {
        operation: "serp",
        provider: SERPAPI_PROVIDER,
        billingCategory: SERPAPI_BILLING_CATEGORY,
        billingQuantity: providerResult.cached ? 0 : 1,
        cached: providerResult.cached,
        creditsCharged,
        result: providerResult.body,
      },
    };
  },
);

export const zeroSeo$ = command(
  async (
    { set },
    args: AuthedSeoArgs,
    signal: AbortSignal,
  ): Promise<ZeroSeoCommandResponse> => {
    const dataForSeo = dataForSeoRequest(args.request);
    if (dataForSeo) {
      return await set(
        runDataForSeo$,
        { ...args, request: dataForSeo },
        signal,
      );
    }
    if (
      args.request.operation === "serp" &&
      args.request.body.provider === "serpapi"
    ) {
      return await set(
        runSerpApi$,
        {
          ...args,
          request: {
            operation: "serp",
            body: { ...args.request.body, provider: "serpapi" },
          },
        },
        signal,
      );
    }
    throw new Error("Unsupported Zero SEO provider");
  },
);
