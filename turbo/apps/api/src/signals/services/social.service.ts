import {
  findManagedSocialKitOperation,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  SOCIALKIT_MAX_QUERY_VALUE_CHARS,
  type ManagedSocialKitOperation,
  type ManagedSocialKitPagination,
  type SocialKitRequest,
  type SocialKitResponse,
} from "@okouai/api-contracts/contracts/social";
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

type ProviderFailureKind =
  | "credential_leak"
  | "http_error"
  | "invalid_response"
  | "network"
  | "response_too_large"
  | "timeout";

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
  readonly operation: ManagedSocialKitOperation;
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

function logProviderFailure(
  operation: ManagedSocialKitOperation,
  failureKind: ProviderFailureKind,
  httpStatus?: number,
): void {
  L.warn("Managed SocialKit request failed", {
    operation: `${operation.method} ${operation.path}`,
    failureKind,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
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

function providerUrl(request: SocialKitRequest): URL {
  const url = new URL(request.path, SOCIALKIT_API_BASE);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

function providerRequestInit(
  accessKey: string,
  request: SocialKitRequest,
  signal: AbortSignal,
): RequestInit {
  return {
    method: request.method,
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
  operation: ManagedSocialKitOperation,
  signal: AbortSignal,
): Promise<SocialKitBodyResult> {
  const settled = await settle(
    (async (): Promise<SocialKitFetchResult> => {
      const response = await fetch(
        providerUrl(request),
        providerRequestInit(accessKey, request, signal),
      );
      const textResult = await readBoundedResponseText(
        response,
        MAX_SOCIALKIT_RESPONSE_BYTES,
      );
      if (textResult.kind === "too_large") {
        logProviderFailure(operation, "response_too_large", response.status);
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
      logProviderFailure(operation, "timeout");
      return errorResult(
        badGateway("SocialKit request timed out", "SOCIALKIT_REQUEST_TIMEOUT"),
      );
    }
    logProviderFailure(operation, "network");
    return errorResult(
      badGateway("SocialKit request failed", "SOCIALKIT_UPSTREAM_ERROR"),
    );
  }
  if (settled.value.kind === "error") {
    return settled.value;
  }
  if (!settled.value.response.ok) {
    logProviderFailure(operation, "http_error", settled.value.response.status);
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
  operation: ManagedSocialKitOperation,
):
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly collection: SocialKitResponse["collection"];
      readonly billingQuantity: number;
    }
  | { readonly ok: false; readonly credentialLeak: boolean } {
  if (
    !isRecord(body) ||
    body.success !== true ||
    !("data" in body) ||
    body.data === undefined
  ) {
    return { ok: false, credentialLeak: false };
  }
  const serialized = JSON.stringify(body.data);
  if (serialized === undefined) {
    return { ok: false, credentialLeak: false };
  }
  if (serialized.includes(accessKey)) {
    return { ok: false, credentialLeak: true };
  }
  const collection = validatedCollection(body.data, request, operation);
  if (collection === undefined) {
    return { ok: false, credentialLeak: false };
  }
  const billingQuantity = operation.collection?.itemsPerBillingUnit
    ? Math.max(
        1,
        Math.ceil(
          collection === null
            ? 0
            : collection.itemsReturned /
                operation.collection.itemsPerBillingUnit,
        ),
      )
    : 1;
  return {
    ok: true,
    result: body.data,
    collection,
    billingQuantity,
  };
}

function effectiveResultLimit(
  request: SocialKitRequest,
  operation: ManagedSocialKitOperation,
): number | undefined {
  const defaultLimit = operation.collection?.defaultLimit;
  if (defaultLimit === undefined) {
    return undefined;
  }
  const requestedLimit = request.query?.limit;
  return requestedLimit === undefined ? defaultLimit : Number(requestedLimit);
}

function requestWithDefaultLimit(
  request: SocialKitRequest,
  operation: ManagedSocialKitOperation,
): SocialKitRequest {
  const defaultLimit = operation.collection?.defaultLimit;
  return defaultLimit === undefined || request.query?.limit !== undefined
    ? request
    : {
        ...request,
        query: { ...request.query, limit: String(defaultLimit) },
      };
}

function paginationQueryValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SOCIALKIT_MAX_QUERY_VALUE_CHARS
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
  const cursor = paginationQueryValue(result.cursor);
  return cursor === undefined
    ? undefined
    : { state: "more", itemsReturned, nextQuery: { cursor } };
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
  const cursor = paginationQueryValue(result.nextCursor);
  return cursor === undefined
    ? undefined
    : { state: "more", itemsReturned, nextQuery: { cursor } };
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
        nextQuery: { page: String(currentPage + 1) },
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
      return validatedPagePagination(
        result,
        itemsReturned,
        Number(request.query?.page ?? "1"),
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
  operation: ManagedSocialKitOperation,
): SocialKitResponse["collection"] | undefined {
  const collection = operation.collection;
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
  const effectiveLimit = effectiveResultLimit(request, operation);
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
  operation: ManagedSocialKitOperation,
): number {
  const itemsPerBillingUnit = operation.collection?.itemsPerBillingUnit;
  const resultLimit = effectiveResultLimit(request, operation);
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
    args.operation,
    providerSignal,
  );
  if (providerResponse.kind === "error") {
    return providerResponse.error;
  }
  const parsed = providerResult(
    providerResponse.body,
    args.accessKey,
    args.request,
    args.operation,
  );
  if (!parsed.ok) {
    const failureKind = parsed.credentialLeak
      ? "credential_leak"
      : "invalid_response";
    logProviderFailure(args.operation, failureKind);
    return invalidResponse();
  }
  const creditsCharged = await args.recordUsage(parsed.billingQuantity);
  return {
    status: 200,
    body: {
      provider: PROVIDER,
      operation: {
        method: args.operation.method,
        path: args.operation.path,
      },
      billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      billingQuantity: parsed.billingQuantity,
      creditsCharged,
      collection: parsed.collection,
      result: parsed.result,
    },
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

    const operation = findManagedSocialKitOperation(
      args.body.method,
      args.body.path,
    );
    if (!operation) {
      throw new Error("Validated SocialKit request has no reviewed operation");
    }
    const providerRequest = requestWithDefaultLimit(args.body, operation);
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const preflightResource = {
      kind: USAGE_KIND,
      provider: PROVIDER,
      category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      quantity: preflightBillingQuantity(providerRequest, operation),
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
        request: providerRequest,
        operation,
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
