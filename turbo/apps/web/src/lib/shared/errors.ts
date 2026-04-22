/**
 * Custom API errors using factory functions and type guards.
 *
 * The factory+type-guard pattern (rather than `class ApiError extends Error`)
 * is intentional — errors thrown here cross serverless function boundaries
 * and must round-trip cleanly through JSON. Inheriting from a project-local
 * class would lose `instanceof` semantics after serialization, so factories
 * mint plain `Error` instances carrying a literal `name`, `code`, and
 * `statusCode`; type guards then narrow via the string `name`.
 */

interface ApiErrorBase extends Error {
  readonly statusCode: number;
  readonly code: string;
}

/**
 * Build a typed factory that mints an `ApiErrorBase` carrying a literal
 * `name`, `code`, and `statusCode`.
 *
 * Two overloads preserve the required-vs-optional message contract of
 * individual factories:
 * - With `defaultMessage` → resulting factory takes `message?: string`
 * - Without `defaultMessage` → resulting factory takes `message: string`
 */
function makeApiError<N extends string, C extends string, S extends number>(
  name: N,
  code: C,
  statusCode: S,
  defaultMessage: string,
): (message?: string) => ApiErrorBase & { name: N; code: C; statusCode: S };
function makeApiError<N extends string, C extends string, S extends number>(
  name: N,
  code: C,
  statusCode: S,
): (message: string) => ApiErrorBase & { name: N; code: C; statusCode: S };
function makeApiError<N extends string, C extends string, S extends number>(
  name: N,
  code: C,
  statusCode: S,
  defaultMessage?: string,
): (message?: string) => ApiErrorBase & { name: N; code: C; statusCode: S } {
  return (message?: string) => {
    const err = new Error(message ?? defaultMessage);
    Object.assign(err, { name, code, statusCode });
    return err as ApiErrorBase & { name: N; code: C; statusCode: S };
  };
}

// ============================================================================
// Factory Functions
// ============================================================================

export const unauthorized = makeApiError(
  "UnauthorizedError",
  "UNAUTHORIZED",
  401,
  "Unauthorized",
);

export const notFound = makeApiError(
  "NotFoundError",
  "NOT_FOUND",
  404,
  "Resource not found",
);

export const badRequest = makeApiError(
  "BadRequestError",
  "BAD_REQUEST",
  400,
  "Bad request",
);

export const forbidden = makeApiError(
  "ForbiddenError",
  "FORBIDDEN",
  403,
  "Forbidden",
);

export const conflict = makeApiError(
  "ConflictError",
  "CONFLICT",
  409,
  "Resource already exists",
);

export const schedulePast = makeApiError(
  "SchedulePastError",
  "SCHEDULE_PAST",
  400,
  "Schedule time has already passed",
);

export const concurrentRunLimit = makeApiError(
  "ConcurrentRunLimitError",
  "TOO_MANY_REQUESTS",
  429,
  "You have reached the concurrent agent run limit. Please wait for your current run to complete before starting a new one.",
);

export const insufficientCredits = makeApiError(
  "InsufficientCreditsError",
  "INSUFFICIENT_CREDITS",
  402,
  "Insufficient credits. Add credits or configure your own API key to continue.",
);

export const providerIncompatible = makeApiError(
  "ProviderIncompatibleError",
  "PROVIDER_INCOMPATIBLE",
  400,
);

export const runNotCancellable = makeApiError(
  "RunNotCancellableError",
  "RUN_NOT_CANCELLABLE",
  400,
);

export const noModelProvider = makeApiError(
  "NoModelProviderError",
  "NO_MODEL_PROVIDER",
  422,
  "No model provider configured. Run 'zero org model-provider setup' to configure one, or add environment variables to your vm0.yaml.",
);

// ============================================================================
// Type Guards
// ============================================================================

export function isNotFound(e: unknown): e is ReturnType<typeof notFound> {
  return e instanceof Error && e.name === "NotFoundError";
}

export function isBadRequest(e: unknown): e is ReturnType<typeof badRequest> {
  return e instanceof Error && e.name === "BadRequestError";
}

export function isConflict(e: unknown): e is ReturnType<typeof conflict> {
  return e instanceof Error && e.name === "ConflictError";
}

export function isForbidden(e: unknown): e is ReturnType<typeof forbidden> {
  return e instanceof Error && e.name === "ForbiddenError";
}

export function isSchedulePast(
  e: unknown,
): e is ReturnType<typeof schedulePast> {
  return e instanceof Error && e.name === "SchedulePastError";
}

export function isConcurrentRunLimit(
  e: unknown,
): e is ReturnType<typeof concurrentRunLimit> {
  return e instanceof Error && e.name === "ConcurrentRunLimitError";
}

export function isInsufficientCredits(
  e: unknown,
): e is ReturnType<typeof insufficientCredits> {
  return e instanceof Error && e.name === "InsufficientCreditsError";
}

export function isNoModelProvider(
  e: unknown,
): e is ReturnType<typeof noModelProvider> {
  return e instanceof Error && e.name === "NoModelProviderError";
}

export function isRunNotCancellable(
  e: unknown,
): e is ReturnType<typeof runNotCancellable> {
  return e instanceof Error && e.name === "RunNotCancellableError";
}

export function isApiError(e: unknown): e is ApiErrorBase {
  return e instanceof Error && "statusCode" in e && "code" in e;
}
