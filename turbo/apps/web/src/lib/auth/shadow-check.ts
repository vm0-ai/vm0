import { env } from "../../env";
import { logger } from "../shared/logger";

import type { AuthContext } from "./get-auth-context";

const log = logger("auth:shadow");

type AuthErrorResponse = {
  status: 401 | 403;
  body: { error: { message: string; code: string } };
};

type WebResult = AuthContext | AuthErrorResponse;

interface ShadowOptions {
  readonly authHeader: string | undefined;
  readonly cookieHeader?: string;
  readonly route?: string;
  readonly requiredCapability?: string;
  readonly acceptAnySandboxCapability?: boolean;
  readonly accept?: string;
}

const COMPARED_FIELDS = [
  "userId",
  "orgId",
  "orgRole",
  "tokenType",
  "runId",
  "capabilities",
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

interface ApiResponseSuccess {
  readonly kind: "success";
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface ApiResponseError {
  readonly kind: "auth_error";
  readonly status: number;
  readonly code: string;
}

interface ApiResponseNetwork {
  readonly kind: "network_error";
  readonly message: string;
}

type ApiResponse = ApiResponseSuccess | ApiResponseError | ApiResponseNetwork;

async function probeApi(
  apiUrl: string,
  authHeader: string,
  cookieHeader?: string,
  params?: {
    requiredCapability?: string;
    acceptAnySandboxCapability?: boolean;
    accept?: string;
  },
): Promise<ApiResponse> {
  const target = new URL("/health/auth", apiUrl);
  if (params?.requiredCapability) {
    target.searchParams.set("requiredCapability", params.requiredCapability);
  }
  if (params?.acceptAnySandboxCapability) {
    target.searchParams.set("acceptAnySandboxCapability", "true");
  }
  if (params?.accept) {
    target.searchParams.set("accept", params.accept);
  }
  const headers: Record<string, string> = { authorization: authHeader };
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }
  const response = await fetch(target.toString(), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(2000),
  }).catch((err: unknown) => {
    return err instanceof Error ? err : new Error(String(err));
  });

  if (response instanceof Error) {
    return { kind: "network_error", message: response.message };
  }

  const body: unknown = await response.json().catch(() => {
    return null;
  });

  if (response.status >= 200 && response.status < 300) {
    return {
      kind: "success",
      status: response.status,
      body: (body ?? {}) as Record<string, unknown>,
    };
  }

  const code =
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error?: unknown }).error === "object" &&
    (body as { error: { code?: unknown } }).error.code !== undefined
      ? String((body as { error: { code: unknown } }).error.code)
      : "UNKNOWN";

  return { kind: "auth_error", status: response.status, code };
}

function isWebAuthError(result: WebResult): result is AuthErrorResponse {
  return "status" in result;
}

function fieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => {
      return value === b[index];
    });
  }
  return false;
}

function diffFields(
  web: AuthContext,
  api: Record<string, unknown>,
): Partial<Record<ComparedField, { web: unknown; api: unknown }>> {
  const out: Partial<Record<ComparedField, { web: unknown; api: unknown }>> =
    {};
  for (const field of COMPARED_FIELDS) {
    const webValue = web[field];
    const apiValue = api[field];
    if (!fieldEqual(webValue, apiValue)) {
      out[field] = { web: webValue, api: apiValue };
    }
  }
  return out;
}

interface ShadowEvent {
  readonly timestamp: string;
  readonly route?: string;
  readonly tokenType: string;
  readonly webOutcome: "success" | "auth_error";
  readonly webStatus?: number;
  readonly webErrorCode?: string;
  readonly apiOutcome: ApiResponse["kind"];
  readonly apiStatus?: number;
  readonly apiErrorCode?: string;
  readonly apiErrorMessage?: string;
  readonly consistent: boolean;
  readonly differences?: ReadonlyArray<string>;
  readonly differenceDetails?: Record<string, { web: unknown; api: unknown }>;
}

function compare(
  web: WebResult,
  api: ApiResponse,
  route: string | undefined,
): ShadowEvent {
  const baseTimestamp = new Date().toISOString();

  if (api.kind === "network_error") {
    return {
      timestamp: baseTimestamp,
      route,
      tokenType: isWebAuthError(web) ? "none" : (web.tokenType ?? "unknown"),
      webOutcome: isWebAuthError(web) ? "auth_error" : "success",
      webStatus: isWebAuthError(web) ? web.status : 200,
      webErrorCode: isWebAuthError(web) ? web.body.error.code : undefined,
      apiOutcome: api.kind,
      apiErrorMessage: api.message,
      consistent: false,
    };
  }

  if (isWebAuthError(web)) {
    const consistent = api.kind === "auth_error";
    return {
      timestamp: baseTimestamp,
      route,
      tokenType: "none",
      webOutcome: "auth_error",
      webStatus: web.status,
      webErrorCode: web.body.error.code,
      apiOutcome: api.kind,
      apiStatus: api.status,
      apiErrorCode: api.kind === "auth_error" ? api.code : undefined,
      consistent,
      differences: consistent ? undefined : ["outcome"],
    };
  }

  if (api.kind === "auth_error") {
    return {
      timestamp: baseTimestamp,
      route,
      tokenType: web.tokenType ?? "unknown",
      webOutcome: "success",
      webStatus: 200,
      apiOutcome: api.kind,
      apiStatus: api.status,
      apiErrorCode: api.code,
      consistent: false,
      differences: ["outcome"],
    };
  }

  const fieldDiffs = diffFields(web, api.body);
  const fieldNames = Object.keys(fieldDiffs);
  return {
    timestamp: baseTimestamp,
    route,
    tokenType: web.tokenType ?? "unknown",
    webOutcome: "success",
    webStatus: 200,
    apiOutcome: api.kind,
    apiStatus: api.status,
    consistent: fieldNames.length === 0,
    differences: fieldNames.length > 0 ? fieldNames : undefined,
    differenceDetails: fieldNames.length > 0 ? fieldDiffs : undefined,
  };
}

/**
 * Shadow-call the new `/health/auth` probe with the same Bearer credential
 * the caller already presented and log a warning on any divergence.
 *
 * When a cookie is available, it is forwarded to the API so the probe can
 * fall through to Clerk session auth for requests where the Bearer token
 * is not self-sufficient.
 */
export async function shadowCompareAuth(
  webResult: WebResult,
  options: ShadowOptions,
): Promise<void> {
  const apiUrl = env().VM0_API_BACKEND_URL;
  if (!apiUrl) {
    return;
  }
  if (!options.authHeader) {
    return;
  }

  const apiResponse = await probeApi(
    apiUrl,
    options.authHeader,
    options.cookieHeader,
    {
      requiredCapability: options.requiredCapability,
      acceptAnySandboxCapability: options.acceptAnySandboxCapability,
      accept: options.accept,
    },
  );
  const event = compare(webResult, apiResponse, options.route);

  if (!event.consistent) {
    log.warn("auth shadow check mismatch", {
      route: options.route,
      tokenType: event.tokenType,
      webOutcome: event.webOutcome,
      webStatus: event.webStatus,
      webErrorCode: event.webErrorCode,
      apiOutcome: event.apiOutcome,
      apiStatus: event.apiStatus,
      apiErrorCode: event.apiErrorCode,
      apiErrorMessage: event.apiErrorMessage,
      differences: event.differences,
      differenceDetails: event.differenceDetails,
    });
  }
}
