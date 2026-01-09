import { describe, it, expect } from "vitest";
import {
  createPublicApiErrorResponse,
  invalidParameterError,
  missingParameterError,
  invalidApiKeyError,
  missingApiKeyError,
  insufficientScopeError,
  resourceNotFoundError,
  resourceAlreadyExistsError,
  rateLimitExceededError,
  internalServerError,
  isPublicApiError,
} from "../errors";
import { errorTypeToStatus } from "@vm0/core";

describe("Public API Errors", () => {
  describe("createPublicApiErrorResponse", () => {
    it("should create error response with correct status", async () => {
      const response = createPublicApiErrorResponse(
        "invalid_request_error",
        "test_code",
        "Test message",
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("test_code");
      expect(body.error.message).toBe("Test message");
    });

    it("should include optional param and doc_url", async () => {
      const response = createPublicApiErrorResponse(
        "invalid_request_error",
        "test_code",
        "Test message",
        { param: "test_param", docUrl: "https://docs.example.com" },
      );

      const body = await response.json();
      expect(body.error.param).toBe("test_param");
      expect(body.error.doc_url).toBe("https://docs.example.com");
    });
  });

  describe("Error type to status mapping", () => {
    it("should map api_error to 500", () => {
      expect(errorTypeToStatus.api_error).toBe(500);
    });

    it("should map invalid_request_error to 400", () => {
      expect(errorTypeToStatus.invalid_request_error).toBe(400);
    });

    it("should map authentication_error to 401", () => {
      expect(errorTypeToStatus.authentication_error).toBe(401);
    });

    it("should map authorization_error to 403", () => {
      expect(errorTypeToStatus.authorization_error).toBe(403);
    });

    it("should map not_found_error to 404", () => {
      expect(errorTypeToStatus.not_found_error).toBe(404);
    });

    it("should map rate_limit_error to 429", () => {
      expect(errorTypeToStatus.rate_limit_error).toBe(429);
    });

    it("should map conflict_error to 409", () => {
      expect(errorTypeToStatus.conflict_error).toBe(409);
    });
  });

  describe("Helper functions", () => {
    it("invalidParameterError should return 400", () => {
      const response = invalidParameterError("test_param", "Invalid value");
      expect(response.status).toBe(400);
    });

    it("missingParameterError should return 400", () => {
      const response = missingParameterError("test_param");
      expect(response.status).toBe(400);
    });

    it("invalidApiKeyError should return 401", () => {
      const response = invalidApiKeyError();
      expect(response.status).toBe(401);
    });

    it("missingApiKeyError should return 401", () => {
      const response = missingApiKeyError();
      expect(response.status).toBe(401);
    });

    it("insufficientScopeError should return 403", () => {
      const response = insufficientScopeError("read:agents");
      expect(response.status).toBe(403);
    });

    it("resourceNotFoundError should return 404", () => {
      const response = resourceNotFoundError("agent", "ag_123");
      expect(response.status).toBe(404);
    });

    it("resourceAlreadyExistsError should return 409", () => {
      const response = resourceAlreadyExistsError("agent", "my-agent");
      expect(response.status).toBe(409);
    });

    it("rateLimitExceededError should return 429 with Retry-After header", () => {
      const response = rateLimitExceededError(60);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    });

    it("internalServerError should return 500", () => {
      const response = internalServerError();
      expect(response.status).toBe(500);
    });
  });

  describe("isPublicApiError", () => {
    it("should return true for valid error object", () => {
      const error = {
        error: {
          type: "invalid_request_error",
          code: "test_code",
          message: "Test message",
        },
      };
      expect(isPublicApiError(error)).toBe(true);
    });

    it("should return false for invalid object", () => {
      expect(isPublicApiError(null)).toBe(false);
      expect(isPublicApiError(undefined)).toBe(false);
      expect(isPublicApiError({})).toBe(false);
      expect(isPublicApiError({ error: {} })).toBe(false);
      expect(isPublicApiError({ error: { type: "test" } })).toBe(false);
    });
  });
});
