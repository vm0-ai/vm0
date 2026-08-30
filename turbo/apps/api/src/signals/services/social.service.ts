import {
  findManagedSocialKitTool,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  type ManagedSocialKitPagination,
  type ManagedSocialKitTool,
  type SocialKitRequest,
  type SocialKitResponse,
  socialKitResponseSchema,
} from "@okouai/api-contracts/contracts/social";
import { z } from "zod";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  checkManagedCredits$,
  recordManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "socialkit";
const USAGE_KIND = "social";
const SOCIALKIT_API_BASE = "https://api.socialkit.dev";
const SOCIALKIT_TIMEOUT_MS = 240_000;
const MAX_SOCIALKIT_RESPONSE_BYTES = 4 * 1024 * 1024;
const L = logger("ManagedSocialKit");

type ErrorStatus = 400 | 404 | 502 | 503;

interface SocialKitErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface SocialKitErrorResult {
  readonly kind: "error";
  readonly error: SocialKitErrorResponse;
}

type SocialKitBodyResult =
  | SocialKitErrorResult
  | { readonly kind: "body"; readonly body: unknown };

type SocialKitFetchResult =
  | SocialKitErrorResult
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly body: unknown;
    };

interface AuthedSocialKitArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: SocialKitRequest;
}

interface CompleteSocialKitArgs {
  readonly accessKey: string;
  readonly request: SocialKitRequest;
  readonly tool: ManagedSocialKitTool;
  readonly recordUsage: (quantity: number) => Promise<number>;
}

type SocialKitCommandResponse =
  | { readonly status: 200; readonly body: SocialKitResponse }
  | SocialKitErrorResponse
  | ManagedUsageErrorResponse;

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function errorResponse(
  status: ErrorStatus,
  message: string,
  code: string,
): SocialKitErrorResponse {
  return { status, body: errorBody(message, code) };
}

function badGateway(message: string, code: string): SocialKitErrorResponse {
  return errorResponse(502, message, code);
}

function errorResult(error: SocialKitErrorResponse): SocialKitErrorResult {
  return { kind: "error", error };
}

function invalidResponse(): SocialKitErrorResponse {
  return badGateway(
    "SocialKit returned an invalid response",
    "SOCIALKIT_INVALID_RESPONSE",
  );
}

function providerErrorMessage(body: unknown): string | undefined {
  return isRecord(body) && typeof body.message === "string"
    ? body.message
    : undefined;
}

function providerHttpError(
  status: number,
  body: unknown,
): SocialKitErrorResponse {
  switch (status) {
    case 400: {
      return errorResponse(
        400,
        "SocialKit rejected the request input",
        "SOCIALKIT_INVALID_INPUT",
      );
    }
    case 401: {
      return badGateway(
        "SocialKit provider authentication failed",
        "SOCIALKIT_AUTH_ERROR",
      );
    }
    case 403: {
      const message = providerErrorMessage(body);
      if (message === "Invalid Access key") {
        return badGateway(
          "SocialKit provider authentication failed",
          "SOCIALKIT_AUTH_ERROR",
        );
      }
      if (message === "Request limit exceeded for this month") {
        return errorResponse(
          503,
          "SocialKit provider quota is exhausted",
          "SOCIALKIT_QUOTA_EXHAUSTED",
        );
      }
      return badGateway("SocialKit request failed", "SOCIALKIT_UPSTREAM_ERROR");
    }
    case 404: {
      return errorResponse(
        404,
        "The requested social content is unavailable",
        "SOCIALKIT_CONTENT_UNAVAILABLE",
      );
    }
    case 429: {
      return badGateway(
        "SocialKit is temporarily rate limited",
        "SOCIALKIT_RATE_LIMITED",
      );
    }
    default: {
      return badGateway("SocialKit request failed", "SOCIALKIT_UPSTREAM_ERROR");
    }
  }
}

function requestInputValue(request: SocialKitRequest, name: string): unknown {
  return Object.entries(request.input).find(([key]) => {
    return key === name;
  })?.[1];
}

function providerInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Validated SocialKit input is not JSON serializable");
  }
  return serialized;
}

function providerUrl(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): URL {
  const url = new URL(tool.path, SOCIALKIT_API_BASE);
  for (const [name, value] of Object.entries(request.input)) {
    url.searchParams.set(name, providerInputValue(value));
  }
  if (
    tool.collection?.defaultLimit !== undefined &&
    requestInputValue(request, "limit") === undefined
  ) {
    url.searchParams.set("limit", String(tool.collection.defaultLimit));
  }
  return url;
}

function providerRequestInit(
  accessKey: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "GET",
    headers: { "x-access-key": accessKey },
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(SOCIALKIT_TIMEOUT_MS),
    ]),
  };
}

async function fetchSocialKit(
  accessKey: string,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
  signal: AbortSignal,
): Promise<SocialKitBodyResult> {
  const settled = await settle(
    (async (): Promise<SocialKitFetchResult> => {
      const response = await fetch(
        providerUrl(request, tool),
        providerRequestInit(accessKey, signal),
      );
      const textResult = await readBoundedResponseText(
        response,
        MAX_SOCIALKIT_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        return errorResult(
          badGateway(
            "SocialKit response is too large",
            "SOCIALKIT_OUTPUT_TOO_LARGE",
          ),
        );
      }
      return {
        kind: "response",
        response,
        body: textResult.text ? safeJsonParse(textResult.text) : undefined,
      };
    })(),
  );

  if (!settled.ok) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const { error } = settled;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return errorResult(
        badGateway("SocialKit request timed out", "SOCIALKIT_REQUEST_TIMEOUT"),
      );
    }
    return errorResult(
      badGateway("SocialKit request failed", "SOCIALKIT_UPSTREAM_ERROR"),
    );
  }
  if (settled.value.kind === "error") {
    return settled.value;
  }
  if (!settled.value.response.ok) {
    if (settled.value.response.status === 400) {
      L.warn("Managed SocialKit request failed", {
        tool: tool.name,
        path: tool.path,
        failureKind: "http_error",
        httpStatus: settled.value.response.status,
      });
    }
    return errorResult(
      providerHttpError(settled.value.response.status, settled.value.body),
    );
  }
  return { kind: "body", body: settled.value.body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerResult(
  body: unknown,
  accessKey: string,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
):
  | {
      readonly ok: true;
      readonly result: z.infer<ManagedSocialKitTool["resultSchema"]>;
      readonly collection: SocialKitResponse["collection"];
      readonly billingQuantity: number;
    }
  | { readonly ok: false } {
  if (
    !isRecord(body) ||
    body.success !== true ||
    !("data" in body) ||
    body.data === undefined
  ) {
    return { ok: false };
  }
  const serialized = JSON.stringify(body.data);
  if (serialized === undefined) {
    return { ok: false };
  }
  if (serialized.includes(accessKey)) {
    return { ok: false };
  }
  const result = tool.resultSchema.safeParse(body.data);
  if (!result.success) {
    return { ok: false };
  }
  const collection = validatedCollection(result.data, request, tool);
  if (collection === undefined) {
    return { ok: false };
  }
  const billingQuantity = tool.collection?.itemsPerBillingUnit
    ? Math.max(
        1,
        Math.ceil(
          collection === null
            ? 0
            : collection.itemsReturned / tool.collection.itemsPerBillingUnit,
        ),
      )
    : 1;
  return {
    ok: true,
    result: result.data,
    collection,
    billingQuantity,
  };
}

function effectiveResultLimit(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): number | undefined {
  const defaultLimit = tool.collection?.defaultLimit;
  if (defaultLimit === undefined) {
    return undefined;
  }
  const requestedLimit = requestInputValue(request, "limit");
  return typeof requestedLimit === "number" ? requestedLimit : defaultLimit;
}

function paginationCursorValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SOCIALKIT_MAX_INPUT_VALUE_CHARS
    ? value
    : undefined;
}

type ValidatedCollection = NonNullable<SocialKitResponse["collection"]>;

function validatedCursorPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
): ValidatedCollection | undefined {
  if (typeof result.hasMore !== "boolean") {
    return undefined;
  }
  if (!result.hasMore) {
    return { state: "complete", itemsReturned };
  }
  const cursor = paginationCursorValue(result.cursor);
  return cursor === undefined
    ? undefined
    : { state: "more", itemsReturned, nextInput: { cursor } };
}

function validatedNextCursorPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
): ValidatedCollection | undefined {
  if (
    result.nextCursor === undefined ||
    result.nextCursor === null ||
    result.nextCursor === ""
  ) {
    return { state: "complete", itemsReturned };
  }
  const cursor = paginationCursorValue(result.nextCursor);
  return cursor === undefined
    ? undefined
    : { state: "more", itemsReturned, nextInput: { cursor } };
}

function validatedPagePagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  currentPage: number,
  maxPage: number,
): ValidatedCollection | undefined {
  if (typeof result.hasMore !== "boolean") {
    return undefined;
  }
  if (!result.hasMore) {
    return { state: "complete", itemsReturned };
  }
  return currentPage >= maxPage
    ? { state: "provider_limited", itemsReturned }
    : {
        state: "more",
        itemsReturned,
        nextInput: { page: currentPage + 1 },
      };
}

function validatedPagination(
  result: Record<string, unknown>,
  itemsReturned: number,
  request: SocialKitRequest,
  pagination: ManagedSocialKitPagination,
): ValidatedCollection | undefined {
  switch (pagination.kind) {
    case "cursor": {
      return validatedCursorPagination(result, itemsReturned);
    }
    case "next_cursor": {
      return validatedNextCursorPagination(result, itemsReturned);
    }
    case "page": {
      const page = requestInputValue(request, "page");
      return validatedPagePagination(
        result,
        itemsReturned,
        typeof page === "number" ? page : 1,
        pagination.maxPage,
      );
    }
    case "none": {
      return { state: "provider_limited", itemsReturned };
    }
  }
}

function validatedCollection(
  result: unknown,
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): SocialKitResponse["collection"] | undefined {
  const collection = tool.collection;
  if (!collection) {
    return null;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  const items = result[collection.resultField];
  if (!Array.isArray(items)) {
    return undefined;
  }
  const effectiveLimit = effectiveResultLimit(request, tool);
  if (effectiveLimit !== undefined && items.length > effectiveLimit) {
    return undefined;
  }
  return validatedPagination(
    result,
    items.length,
    request,
    collection.pagination,
  );
}

function preflightBillingQuantity(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
): number {
  const itemsPerBillingUnit = tool.collection?.itemsPerBillingUnit;
  const resultLimit = effectiveResultLimit(request, tool);
  return itemsPerBillingUnit === undefined || resultLimit === undefined
    ? 1
    : Math.max(1, Math.ceil(resultLimit / itemsPerBillingUnit));
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

async function completeSocialKitRequest(
  args: CompleteSocialKitArgs,
  providerSignal: AbortSignal,
): Promise<SocialKitCommandResponse> {
  const providerResponse = await fetchSocialKit(
    args.accessKey,
    args.request,
    args.tool,
    providerSignal,
  );
  if (providerResponse.kind === "error") {
    return providerResponse.error;
  }
  const parsed = providerResult(
    providerResponse.body,
    args.accessKey,
    args.request,
    args.tool,
  );
  if (!parsed.ok) {
    return invalidResponse();
  }
  const creditsCharged = await args.recordUsage(parsed.billingQuantity);
  return {
    status: 200,
    body: socialKitResponseSchema.parse({
      provider: PROVIDER,
      tool: args.tool.name,
      billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      billingQuantity: parsed.billingQuantity,
      creditsCharged,
      collection: parsed.collection,
      result: parsed.result,
    }),
  };
}

export const socialKitRequest$ = command(
  async (
    { get, set },
    args: AuthedSocialKitArgs,
    signal: AbortSignal,
  ): Promise<SocialKitCommandResponse> => {
    const accessKey = env("OKOU_SOCIAL_SOCIALKIT_TOKEN");
    if (!accessKey) {
      return errorResponse(
        503,
        "Okou SocialKit provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const tool = findManagedSocialKitTool(args.body.tool);
    if (!tool) {
      throw new Error("Validated SocialKit request has no reviewed tool");
    }
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const preflightResource = {
      kind: USAGE_KIND,
      provider: PROVIDER,
      category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      quantity: preflightBillingQuantity(args.body, tool),
    };
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: preflightResource,
        label: "Okou SocialKit",
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }

    const runId = runIdForUsage(args.auth);
    return completeSocialKitRequest(
      {
        accessKey,
        request: args.body,
        tool,
        recordUsage: (quantity) => {
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
                category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
                quantity,
              },
              label: "SocialKit request",
            },
            signal,
          );
        },
      },
      requestSignal,
    );
  },
);
