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

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function badRequest(issue: ZodLikeIssue) {
  const path = issue.path.map(String).join(".");
  const message = path ? `${path}: ${issue.message}` : issue.message;
  return httpError(400, "BAD_REQUEST", message);
}
