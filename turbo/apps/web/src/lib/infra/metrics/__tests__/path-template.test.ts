import { describe, expect, it } from "vitest";
import { pathToTemplate } from "../path-template";

describe("pathToTemplate", () => {
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
