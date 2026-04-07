import { describe, it, expect } from "vitest";
import { createSafeErrorHandler } from "../ts-rest-handler";
import { badRequest, notFound, forbidden } from "../shared/errors";

describe("createSafeErrorHandler", () => {
  const handler = createSafeErrorHandler("test-route");

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
});
