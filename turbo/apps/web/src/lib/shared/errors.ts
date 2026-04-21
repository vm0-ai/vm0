/**
 * Custom API errors using factory functions and type guards
 */

// ============================================================================
// Type Definitions
// ============================================================================

interface ApiErrorBase extends Error {
  readonly statusCode: number;
  readonly code: string;
}

interface UnauthorizedError extends ApiErrorBase {
  readonly name: "UnauthorizedError";
  readonly statusCode: 401;
  readonly code: "UNAUTHORIZED";
}

interface NotFoundError extends ApiErrorBase {
  readonly name: "NotFoundError";
  readonly statusCode: 404;
  readonly code: "NOT_FOUND";
}

interface BadRequestError extends ApiErrorBase {
  readonly name: "BadRequestError";
  readonly statusCode: 400;
  readonly code: "BAD_REQUEST";
}

interface ForbiddenError extends ApiErrorBase {
  readonly name: "ForbiddenError";
  readonly statusCode: 403;
  readonly code: "FORBIDDEN";
}

interface ConflictError extends ApiErrorBase {
  readonly name: "ConflictError";
  readonly statusCode: 409;
  readonly code: "CONFLICT";
}

interface SchedulePastError extends ApiErrorBase {
  readonly name: "SchedulePastError";
  readonly statusCode: 400;
  readonly code: "SCHEDULE_PAST";
}

interface ConcurrentRunLimitError extends ApiErrorBase {
  readonly name: "ConcurrentRunLimitError";
  readonly statusCode: 429;
  readonly code: "TOO_MANY_REQUESTS";
}

interface InsufficientCreditsError extends ApiErrorBase {
  readonly name: "InsufficientCreditsError";
  readonly statusCode: 402;
  readonly code: "INSUFFICIENT_CREDITS";
}

interface ProviderIncompatibleError extends ApiErrorBase {
  readonly name: "ProviderIncompatibleError";
  readonly statusCode: 400;
  readonly code: "PROVIDER_INCOMPATIBLE";
}

interface RunNotCancellableError extends ApiErrorBase {
  readonly name: "RunNotCancellableError";
  readonly statusCode: 400;
  readonly code: "RUN_NOT_CANCELLABLE";
}

interface NoModelProviderError extends ApiErrorBase {
  readonly name: "NoModelProviderError";
  readonly statusCode: 422;
  readonly code: "NO_MODEL_PROVIDER";
}

// ============================================================================
// Factory Functions
// ============================================================================

export function unauthorized(message = "Unauthorized"): UnauthorizedError {
  const error = new Error(message) as UnauthorizedError;
  (error as { name: string }).name = "UnauthorizedError";
  (error as { statusCode: number }).statusCode = 401;
  (error as { code: string }).code = "UNAUTHORIZED";
  return error;
}

export function notFound(message = "Resource not found"): NotFoundError {
  const error = new Error(message) as NotFoundError;
  (error as { name: string }).name = "NotFoundError";
  (error as { statusCode: number }).statusCode = 404;
  (error as { code: string }).code = "NOT_FOUND";
  return error;
}

export function badRequest(message = "Bad request"): BadRequestError {
  const error = new Error(message) as BadRequestError;
  (error as { name: string }).name = "BadRequestError";
  (error as { statusCode: number }).statusCode = 400;
  (error as { code: string }).code = "BAD_REQUEST";
  return error;
}

export function conflict(message = "Resource already exists"): ConflictError {
  const error = new Error(message) as ConflictError;
  (error as { name: string }).name = "ConflictError";
  (error as { statusCode: number }).statusCode = 409;
  (error as { code: string }).code = "CONFLICT";
  return error;
}

export function forbidden(message = "Forbidden"): ForbiddenError {
  const error = new Error(message) as ForbiddenError;
  (error as { name: string }).name = "ForbiddenError";
  (error as { statusCode: number }).statusCode = 403;
  (error as { code: string }).code = "FORBIDDEN";
  return error;
}

export function schedulePast(
  message = "Schedule time has already passed",
): SchedulePastError {
  const error = new Error(message) as SchedulePastError;
  (error as { name: string }).name = "SchedulePastError";
  (error as { statusCode: number }).statusCode = 400;
  (error as { code: string }).code = "SCHEDULE_PAST";
  return error;
}

export function concurrentRunLimit(
  message = "You have reached the concurrent agent run limit. Please wait for your current run to complete before starting a new one.",
): ConcurrentRunLimitError {
  const error = new Error(message) as ConcurrentRunLimitError;
  (error as { name: string }).name = "ConcurrentRunLimitError";
  (error as { statusCode: number }).statusCode = 429;
  (error as { code: string }).code = "TOO_MANY_REQUESTS";
  return error;
}

export function insufficientCredits(): InsufficientCreditsError {
  const message =
    "Insufficient credits. Add credits or configure your own API key to continue.";
  const error = new Error(message) as InsufficientCreditsError;
  (error as { name: string }).name = "InsufficientCreditsError";
  (error as { statusCode: number }).statusCode = 402;
  (error as { code: string }).code = "INSUFFICIENT_CREDITS";
  return error;
}

export function providerIncompatible(
  message: string,
): ProviderIncompatibleError {
  const error = new Error(message) as ProviderIncompatibleError;
  (error as { name: string }).name = "ProviderIncompatibleError";
  (error as { statusCode: number }).statusCode = 400;
  (error as { code: string }).code = "PROVIDER_INCOMPATIBLE";
  return error;
}

export function runNotCancellable(message: string): RunNotCancellableError {
  const error = new Error(message) as RunNotCancellableError;
  (error as { name: string }).name = "RunNotCancellableError";
  (error as { statusCode: number }).statusCode = 400;
  (error as { code: string }).code = "RUN_NOT_CANCELLABLE";
  return error;
}

export function noModelProvider(
  message = "No model provider configured. Run 'zero org model-provider setup' to configure one, or add environment variables to your vm0.yaml.",
): NoModelProviderError {
  const error = new Error(message) as NoModelProviderError;
  (error as { name: string }).name = "NoModelProviderError";
  (error as { statusCode: number }).statusCode = 422;
  (error as { code: string }).code = "NO_MODEL_PROVIDER";
  return error;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isNotFound(e: unknown): e is NotFoundError {
  return e instanceof Error && e.name === "NotFoundError";
}

export function isBadRequest(e: unknown): e is BadRequestError {
  return e instanceof Error && e.name === "BadRequestError";
}

export function isConflict(e: unknown): e is ConflictError {
  return e instanceof Error && e.name === "ConflictError";
}

export function isForbidden(e: unknown): e is ForbiddenError {
  return e instanceof Error && e.name === "ForbiddenError";
}

export function isSchedulePast(e: unknown): e is SchedulePastError {
  return e instanceof Error && e.name === "SchedulePastError";
}

export function isConcurrentRunLimit(e: unknown): e is ConcurrentRunLimitError {
  return e instanceof Error && e.name === "ConcurrentRunLimitError";
}

export function isInsufficientCredits(
  e: unknown,
): e is InsufficientCreditsError {
  return e instanceof Error && e.name === "InsufficientCreditsError";
}

export function isNoModelProvider(e: unknown): e is NoModelProviderError {
  return e instanceof Error && e.name === "NoModelProviderError";
}

export function isRunNotCancellable(e: unknown): e is RunNotCancellableError {
  return e instanceof Error && e.name === "RunNotCancellableError";
}

export function isApiError(e: unknown): e is ApiErrorBase {
  return e instanceof Error && "statusCode" in e && "code" in e;
}
