import {
  findManagedSocialKitOperation,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  type ManagedSocialKitOperation,
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
  readonly recordUsage: () => Promise<number>;
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
):
  | { readonly ok: true; readonly result: unknown }
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
  return { ok: true, result: body.data };
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
  const parsed = providerResult(providerResponse.body, args.accessKey);
  if (!parsed.ok) {
    const failureKind = parsed.credentialLeak
      ? "credential_leak"
      : "invalid_response";
    logProviderFailure(args.operation, failureKind);
    return invalidResponse();
  }
  const creditsCharged = await args.recordUsage();
  return {
    status: 200,
    body: {
      provider: PROVIDER,
      operation: {
        method: args.operation.method,
        path: args.operation.path,
      },
      billingCategory: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      billingQuantity: 1,
      creditsCharged,
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
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    const resource = {
      kind: USAGE_KIND,
      provider: PROVIDER,
      category: MANAGED_SOCIALKIT_BILLING_CATEGORY,
      quantity: 1,
    };
    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource,
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
        operation,
        recordUsage: () => {
          return set(
            recordManagedUsage$,
            {
              actor: {
                orgId: args.auth.orgId,
                userId: args.auth.userId,
                ...(runId ? { runId } : {}),
              },
              resource,
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
