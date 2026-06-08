export interface ApiErrorBody<CODE extends string = string> {
  readonly error: {
    readonly message: string;
    readonly code: CODE;
  };
}

export interface ApiErrorResponse<
  STATUS extends number = number,
  CODE extends string = string,
> {
  readonly status: STATUS;
  readonly body: ApiErrorBody<CODE>;
}

function httpError<STATUS extends number, CODE extends string>(
  status: STATUS,
  code: CODE,
  message: string,
): ApiErrorResponse<STATUS, CODE> {
  return Object.freeze({
    status,
    body: {
      error: {
        message,
        code,
      },
    },
  });
}

export class ApiRouteError extends Error {
  readonly response: ApiErrorResponse;

  constructor(response: ApiErrorResponse, options?: ErrorOptions) {
    super(response.body.error.message, options);
    this.name = "ApiRouteError";
    this.response = response;
  }
}

export function isApiRouteError(error: unknown): error is ApiRouteError {
  return error instanceof ApiRouteError;
}

export function throwApiError(response: ApiErrorResponse): never {
  throw new ApiRouteError(response);
}

export function notFound(message: string) {
  return httpError(404, "NOT_FOUND", message);
}

export function conflict(message: string) {
  return httpError(409, "CONFLICT", message);
}

export function runNotCancellable(message: string) {
  return httpError(400, "RUN_NOT_CANCELLABLE", message);
}

export function providerUnavailable(message: string) {
  return httpError(503, "PROVIDER_UNAVAILABLE", message);
}

export function providerDeleted() {
  return httpError(
    422,
    "PROVIDER_DELETED",
    "The selected model provider is no longer available",
  );
}

export function insufficientCredits() {
  return httpError(
    402,
    "INSUFFICIENT_CREDITS",
    "Insufficient credits. Add credits or configure your own API key to continue.",
  );
}

export function badRequestMessage(message: string) {
  return httpError(400, "BAD_REQUEST", message);
}

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function badRequest(issue: ZodLikeIssue) {
  const path = issue.path.map(String).join(".");
  const message = path ? `${path}: ${issue.message}` : issue.message;
  return httpError(400, "BAD_REQUEST", message);
}

type HttpResponseLike<S extends number> = {
  readonly status: S;
  readonly body: unknown;
};

function isHttpResponse<S extends number>(
  value: unknown,
  status: S,
): value is HttpResponseLike<S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === status
  );
}

export function isBadRequestResponse(
  value: unknown,
): value is HttpResponseLike<400> {
  return isHttpResponse(value, 400);
}

export function isNotFoundResponse(
  value: unknown,
): value is HttpResponseLike<404> {
  return isHttpResponse(value, 404);
}

export function isConflictResponse(
  value: unknown,
): value is HttpResponseLike<409> {
  return isHttpResponse(value, 409);
}
