import { isRecord, stringProperty } from "../utils.ts";

export interface AuthV2ClerkError {
  readonly code: "clerk" | "rate-limited" | "unknown";
  readonly clerkCode?: string;
  readonly clerkParamName?: string;
}

export function normalizeClerkAuthError(error: unknown): AuthV2ClerkError {
  if (!isRecord(error)) {
    return { code: "unknown" };
  }
  // Match Clerk's is429Error independently of the API error's code.
  if (error.status === 429) {
    return { code: "rate-limited" };
  }
  // ClerkRuntimeError / ClerkOfflineError have a top-level code, whereas
  // ClerkAPIResponseError contains parsed errors with camel-cased meta keys.
  const apiError = Array.isArray(error.errors)
    ? error.errors.find(isRecord)
    : undefined;
  const detail = apiError ?? error;
  const clerkCode = stringProperty(detail, "code");
  if (!clerkCode) {
    return { code: "unknown" };
  }
  const clerkParamName = isRecord(detail.meta)
    ? stringProperty(detail.meta, "paramName")
    : undefined;
  return {
    code: "clerk",
    clerkCode,
    ...(clerkParamName ? { clerkParamName } : {}),
  };
}
