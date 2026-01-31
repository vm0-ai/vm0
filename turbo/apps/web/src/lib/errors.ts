/**
 * Custom error classes for API
 */

// eslint-disable-next-line no-restricted-syntax -- legacy code
class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class NotFoundError extends ApiError {
  constructor(message = "Resource not found") {
    super(404, message, "NOT_FOUND");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class BadRequestError extends ApiError {
  constructor(message = "Bad request") {
    super(400, message, "BAD_REQUEST");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class ConflictError extends ApiError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class SchedulePastError extends ApiError {
  constructor(message = "Schedule time has already passed") {
    super(400, message, "SCHEDULE_PAST");
  }
}

// eslint-disable-next-line no-restricted-syntax -- legacy code
export class ConcurrentRunLimitError extends ApiError {
  constructor(
    message = "You have reached the concurrent agent run limit. Please wait for your current run to complete before starting a new one.",
  ) {
    super(429, message, "TOO_MANY_REQUESTS");
  }
}
