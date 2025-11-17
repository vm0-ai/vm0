/**
 * Custom error classes for API
 */

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class NotFoundError extends ApiError {
  constructor(resource = "Resource") {
    super(404, `${resource} not found`, "NOT_FOUND");
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Bad request") {
    super(400, message, "BAD_REQUEST");
  }
}

export class InternalServerError extends ApiError {
  constructor(message = "Internal server error") {
    super(500, message, "INTERNAL_SERVER_ERROR");
  }
}
