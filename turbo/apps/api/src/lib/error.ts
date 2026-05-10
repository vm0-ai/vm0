function httpError<STATUS extends number, CODE extends string>(
  status: STATUS,
  code: CODE,
  message: string,
) {
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

export function notFound(message: string) {
  return httpError(404, "NOT_FOUND", message);
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
