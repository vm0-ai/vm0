import { describe, it, expect } from "vitest";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  getOrGenerateRequestId,
} from "../request-id";

describe("Request ID", () => {
  describe("REQUEST_ID_HEADER", () => {
    it("should have correct header name", () => {
      expect(REQUEST_ID_HEADER).toBe("X-Request-Id");
    });
  });

  describe("generateRequestId", () => {
    it("should generate ID with req_ prefix", () => {
      const id = generateRequestId();
      expect(id).toMatch(/^req_[a-f0-9]+$/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRequestId());
      }
      expect(ids.size).toBe(100);
    });

    it("should generate IDs of consistent length", () => {
      const id = generateRequestId();
      // "req_" + 32 hex chars (UUID without dashes)
      expect(id).toHaveLength(36); // 4 + 32
    });
  });

  describe("getOrGenerateRequestId", () => {
    it("should use client-provided ID if it has req_ prefix", () => {
      const headers = new Headers();
      headers.set("X-Request-Id", "req_abc123def456");

      const id = getOrGenerateRequestId(headers);
      expect(id).toBe("req_abc123def456");
    });

    it("should generate new ID if client ID lacks req_ prefix", () => {
      const headers = new Headers();
      headers.set("X-Request-Id", "custom-id-123");

      const id = getOrGenerateRequestId(headers);
      expect(id).toMatch(/^req_[a-f0-9]+$/);
    });

    it("should generate new ID if no header provided", () => {
      const headers = new Headers();

      const id = getOrGenerateRequestId(headers);
      expect(id).toMatch(/^req_[a-f0-9]+$/);
    });
  });
});
