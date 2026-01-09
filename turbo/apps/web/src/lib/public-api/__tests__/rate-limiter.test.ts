import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  getRateLimitInfo,
  setRateLimitHeaders,
  resetRateLimits,
  DEFAULT_RATE_LIMIT,
} from "../rate-limiter";

describe("Rate Limiter", () => {
  beforeEach(() => {
    // Reset rate limits between tests
    resetRateLimits();
  });

  describe("checkRateLimit", () => {
    it("should allow requests within limit", () => {
      const userId = "test-user-1";
      const endpoint = "GET /v1/agents";

      const result = checkRateLimit(userId, endpoint, {
        limit: 10,
        windowSeconds: 60,
      });

      expect(result).not.toBeNull();
      expect(result?.limit).toBe(10);
      expect(result?.remaining).toBe(9);
    });

    it("should decrement remaining count on each request", () => {
      const userId = "test-user-2";
      const endpoint = "GET /v1/runs";
      const config = { limit: 5, windowSeconds: 60 };

      checkRateLimit(userId, endpoint, config);
      checkRateLimit(userId, endpoint, config);
      const result = checkRateLimit(userId, endpoint, config);

      expect(result?.remaining).toBe(2);
    });

    it("should return null when limit is exceeded", () => {
      const userId = "test-user-3";
      const endpoint = "POST /v1/runs";
      const config = { limit: 2, windowSeconds: 60 };

      checkRateLimit(userId, endpoint, config);
      checkRateLimit(userId, endpoint, config);
      const result = checkRateLimit(userId, endpoint, config);

      expect(result).toBeNull();
    });

    it("should track limits separately per user", () => {
      const endpoint = "GET /v1/agents";
      const config = { limit: 3, windowSeconds: 60 };

      checkRateLimit("user-a", endpoint, config);
      checkRateLimit("user-a", endpoint, config);
      const resultA = checkRateLimit("user-a", endpoint, config);

      const resultB = checkRateLimit("user-b", endpoint, config);

      expect(resultA?.remaining).toBe(0);
      expect(resultB?.remaining).toBe(2);
    });

    it("should track limits separately per endpoint", () => {
      const userId = "test-user-4";
      const config = { limit: 3, windowSeconds: 60 };

      checkRateLimit(userId, "GET /v1/agents", config);
      checkRateLimit(userId, "GET /v1/agents", config);
      const resultAgents = checkRateLimit(userId, "GET /v1/agents", config);

      const resultRuns = checkRateLimit(userId, "GET /v1/runs", config);

      expect(resultAgents?.remaining).toBe(0);
      expect(resultRuns?.remaining).toBe(2);
    });
  });

  describe("getRateLimitInfo", () => {
    it("should return full limit when no requests made", () => {
      const userId = "test-user-5";
      const endpoint = "GET /v1/tokens";
      const config = { limit: 100, windowSeconds: 60 };

      const info = getRateLimitInfo(userId, endpoint, config);

      expect(info.limit).toBe(100);
      expect(info.remaining).toBe(100);
    });

    it("should return correct remaining after requests", () => {
      const userId = "test-user-6";
      const endpoint = "POST /v1/tokens";
      const config = { limit: 10, windowSeconds: 60 };

      checkRateLimit(userId, endpoint, config);
      checkRateLimit(userId, endpoint, config);
      checkRateLimit(userId, endpoint, config);

      const info = getRateLimitInfo(userId, endpoint, config);

      expect(info.limit).toBe(10);
      expect(info.remaining).toBe(7);
    });
  });

  describe("setRateLimitHeaders", () => {
    it("should set all rate limit headers", () => {
      const headers = new Headers();
      const info = {
        limit: 1000,
        remaining: 950,
        reset: 1700000000,
      };

      setRateLimitHeaders(headers, info);

      expect(headers.get("X-RateLimit-Limit")).toBe("1000");
      expect(headers.get("X-RateLimit-Remaining")).toBe("950");
      expect(headers.get("X-RateLimit-Reset")).toBe("1700000000");
    });
  });

  describe("DEFAULT_RATE_LIMIT", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_RATE_LIMIT.limit).toBe(1000);
      expect(DEFAULT_RATE_LIMIT.windowSeconds).toBe(3600);
    });
  });
});
