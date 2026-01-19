import { describe, expect, it } from "vitest";
import { pathToTemplate } from "../path-template";

describe("pathToTemplate", () => {
  describe("Public API v1 routes", () => {
    it("should normalize /v1/runs/:id", () => {
      expect(pathToTemplate("/v1/runs/abc-123-def-456-ghi")).toBe(
        "/v1/runs/:id",
      );
      expect(
        pathToTemplate("/v1/runs/12345678-1234-1234-1234-123456789abc"),
      ).toBe("/v1/runs/:id");
    });

    it("should normalize /v1/runs/:id/events", () => {
      expect(pathToTemplate("/v1/runs/abc-123/events")).toBe(
        "/v1/runs/:id/events",
      );
    });

    it("should normalize /v1/runs/:id/metrics", () => {
      expect(pathToTemplate("/v1/runs/abc-123/metrics")).toBe(
        "/v1/runs/:id/metrics",
      );
    });

    it("should normalize /v1/agents/:id", () => {
      expect(pathToTemplate("/v1/agents/agent-xyz")).toBe("/v1/agents/:id");
    });

    it("should normalize /v1/artifacts/:id", () => {
      expect(pathToTemplate("/v1/artifacts/artifact-123")).toBe(
        "/v1/artifacts/:id",
      );
    });

    it("should normalize /v1/volumes/:id", () => {
      expect(pathToTemplate("/v1/volumes/vol-456")).toBe("/v1/volumes/:id");
    });
  });

  describe("Internal API routes", () => {
    it("should normalize /api/agent/runs/:id", () => {
      expect(pathToTemplate("/api/agent/runs/run-123")).toBe(
        "/api/agent/runs/:id",
      );
    });

    it("should normalize /api/agent/runs/:id/* nested routes", () => {
      expect(pathToTemplate("/api/agent/runs/run-123/events")).toBe(
        "/api/agent/runs/:id/*",
      );
      expect(pathToTemplate("/api/agent/runs/run-123/status")).toBe(
        "/api/agent/runs/:id/*",
      );
    });

    it("should normalize /api/compose/:id", () => {
      expect(pathToTemplate("/api/compose/compose-123")).toBe(
        "/api/compose/:id",
      );
    });

    it("should normalize /api/compose/:id/* nested routes", () => {
      expect(pathToTemplate("/api/compose/compose-123/start")).toBe(
        "/api/compose/:id/*",
      );
    });
  });

  describe("UUID replacement fallback", () => {
    it("should replace UUIDs with :id", () => {
      expect(
        pathToTemplate("/unknown/12345678-1234-1234-1234-123456789abc"),
      ).toBe("/unknown/:id");
    });

    it("should replace multiple UUIDs", () => {
      expect(
        pathToTemplate(
          "/path/12345678-1234-1234-1234-123456789abc/to/87654321-4321-4321-4321-cba987654321",
        ),
      ).toBe("/path/:id/to/:id");
    });

    it("should handle paths without IDs", () => {
      expect(pathToTemplate("/api/health")).toBe("/api/health");
      expect(pathToTemplate("/api/webhooks/agent/complete")).toBe(
        "/api/webhooks/agent/complete",
      );
    });
  });
});
