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

export interface ConcurrentRunLimitError extends ApiErrorBase {
  readonly name: "ConcurrentRunLimitError";
  readonly statusCode: 429;
  readonly code: "TOO_MANY_REQUESTS";
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

export function forbidden(message = "Forbidden"): ForbiddenError {
  const error = new Error(message) as ForbiddenError;
  (error as { name: string }).name = "ForbiddenError";
  (error as { statusCode: number }).statusCode = 403;
  (error as { code: string }).code = "FORBIDDEN";
  return error;
}

export function conflict(message = "Conflict"): ConflictError {
  const error = new Error(message) as ConflictError;
  (error as { name: string }).name = "ConflictError";
  (error as { statusCode: number }).statusCode = 409;
  (error as { code: string }).code = "CONFLICT";
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

// ============================================================================
// Type Guards
// ============================================================================

export function isNotFound(e: unknown): e is NotFoundError {
  return e instanceof Error && e.name === "NotFoundError";
}

export function isBadRequest(e: unknown): e is BadRequestError {
  return e instanceof Error && e.name === "BadRequestError";
}

export function isForbidden(e: unknown): e is ForbiddenError {
  return e instanceof Error && e.name === "ForbiddenError";
}

export function isConflict(e: unknown): e is ConflictError {
  return e instanceof Error && e.name === "ConflictError";
}

export function isSchedulePast(e: unknown): e is SchedulePastError {
  return e instanceof Error && e.name === "SchedulePastError";
}

export function isConcurrentRunLimit(e: unknown): e is ConcurrentRunLimitError {
  return e instanceof Error && e.name === "ConcurrentRunLimitError";
}
