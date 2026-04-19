import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";

vi.mock("@sentry/nextjs", () => {
  return {
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
  };
});

import { createSafeErrorHandler } from "../ts-rest-handler";
import { badRequest, notFound, forbidden } from "../shared/errors";

describe("createSafeErrorHandler", () => {
  const handler = createSafeErrorHandler("test-route");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return correct status for BadRequestError", async () => {
    const response = handler(badRequest("Missing org context"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Missing org context");
  });

  it("should return correct status for NotFoundError", async () => {
    const response = handler(notFound("Resource not found"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    const body = await response!.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Resource not found");
  });

  it("should return correct status for ForbiddenError", async () => {
    const response = handler(forbidden("Access denied"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(403);
    const body = await response!.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Access denied");
  });

  it("should return 500 with generic message for unknown errors", async () => {
    const response = handler(new Error("database connection failed"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("database");
  });

  it("does not report typed ApiError (4xx) to Sentry", async () => {
    const response = handler(badRequest("invalid input"));
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it("reports unknown 5xx errors to Sentry with route tag and returns 500", async () => {
    const err = new Error("db timeout");
    const response = handler(err);
    expect(response).toBeDefined();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      mechanism: { type: "ts-rest-handler", handled: true },
      captureContext: { tags: { route: "test-route" } },
    });
  });
});
