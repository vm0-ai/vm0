/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  computeComposeVersionId,
  formatShortVersion,
  isValidVersionId,
  isValidVersionPrefix,
  parseComposeReference,
  FULL_VERSION_LENGTH,
  DEFAULT_VERSION_DISPLAY_LENGTH,
  MIN_VERSION_PREFIX_LENGTH,
} from "../content-hash";
import type { AgentComposeYaml } from "../../../types/agent-compose";

describe("content-hash", () => {
  describe("computeComposeVersionId", () => {
    it("should produce a 64-character hexadecimal hash", () => {
      const content: AgentComposeYaml = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "test-image",
            working_dir: "/workspace",
          },
        },
      };

      const versionId = computeComposeVersionId(content);

      expect(versionId).toHaveLength(FULL_VERSION_LENGTH);
      expect(versionId).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce the same hash for identical content", () => {
      const content1: AgentComposeYaml = {
        version: "1.0",
        agents: {
          "my-agent": {
            image: "ubuntu",
            working_dir: "/home",
          },
        },
      };

      const content2: AgentComposeYaml = {
        version: "1.0",
        agents: {
          "my-agent": {
            image: "ubuntu",
            working_dir: "/home",
          },
        },
      };

      expect(computeComposeVersionId(content1)).toBe(
        computeComposeVersionId(content2),
      );
    });

    it("should produce the same hash regardless of key order", () => {
      // Object with keys in different order
      const content1 = {
        version: "1.0",
        agents: {
          agent1: {
            working_dir: "/workspace",
            image: "test",
          },
        },
      } as AgentComposeYaml;

      const content2 = {
        agents: {
          agent1: {
            image: "test",
            working_dir: "/workspace",
          },
        },
        version: "1.0",
      } as AgentComposeYaml;

      expect(computeComposeVersionId(content1)).toBe(
        computeComposeVersionId(content2),
      );
    });

    it("should produce different hashes for different content", () => {
      const content1: AgentComposeYaml = {
        version: "1.0",
        agents: {
          agent1: {
            image: "image-a",
            working_dir: "/workspace",
          },
        },
      };

      const content2: AgentComposeYaml = {
        version: "1.0",
        agents: {
          agent1: {
            image: "image-b",
            working_dir: "/workspace",
          },
        },
      };

      expect(computeComposeVersionId(content1)).not.toBe(
        computeComposeVersionId(content2),
      );
    });

    it("should handle nested objects and arrays", () => {
      const content: AgentComposeYaml = {
        version: "1.0",
        agents: {
          agent1: {
            image: "test",
            working_dir: "/workspace",
            env: {
              FOO: "bar",
              BAZ: "qux",
            },
          },
        },
      };

      const versionId = computeComposeVersionId(content);
      expect(versionId).toHaveLength(FULL_VERSION_LENGTH);

      // Same content with different key order should produce same hash
      const content2: AgentComposeYaml = {
        version: "1.0",
        agents: {
          agent1: {
            working_dir: "/workspace",
            image: "test",
            env: {
              BAZ: "qux",
              FOO: "bar",
            },
          },
        },
      };

      expect(computeComposeVersionId(content)).toBe(
        computeComposeVersionId(content2),
      );
    });
  });

  describe("formatShortVersion", () => {
    it("should return the first 8 characters of a version ID", () => {
      const fullId = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6";
      const shortId = formatShortVersion(fullId);

      expect(shortId).toBe("a1b2c3d4");
      expect(shortId).toHaveLength(DEFAULT_VERSION_DISPLAY_LENGTH);
    });

    it("should handle short inputs gracefully", () => {
      const shortInput = "abc";
      expect(formatShortVersion(shortInput)).toBe("abc");
    });
  });

  describe("isValidVersionId", () => {
    it("should return true for valid 64-character hex strings", () => {
      const validId = "a".repeat(64);
      expect(isValidVersionId(validId)).toBe(true);
    });

    it("should return true for lowercase hex", () => {
      const validId = "0123456789abcdef".repeat(4);
      expect(isValidVersionId(validId)).toBe(true);
    });

    it("should return true for uppercase hex (case insensitive)", () => {
      const validId = "0123456789ABCDEF".repeat(4);
      expect(isValidVersionId(validId)).toBe(true);
    });

    it("should return false for strings that are too short", () => {
      expect(isValidVersionId("a".repeat(63))).toBe(false);
    });

    it("should return false for strings that are too long", () => {
      expect(isValidVersionId("a".repeat(65))).toBe(false);
    });

    it("should return false for non-hex characters", () => {
      expect(isValidVersionId("g".repeat(64))).toBe(false);
      expect(isValidVersionId("z".repeat(64))).toBe(false);
    });
  });

  describe("isValidVersionPrefix", () => {
    it("should return true for 8+ character hex strings", () => {
      expect(isValidVersionPrefix("a".repeat(MIN_VERSION_PREFIX_LENGTH))).toBe(
        true,
      );
      expect(isValidVersionPrefix("a".repeat(16))).toBe(true);
      expect(isValidVersionPrefix("a".repeat(64))).toBe(true);
    });

    it("should return false for strings shorter than 8 characters", () => {
      expect(
        isValidVersionPrefix("a".repeat(MIN_VERSION_PREFIX_LENGTH - 1)),
      ).toBe(false);
      expect(isValidVersionPrefix("abc")).toBe(false);
    });

    it("should return false for non-hex characters", () => {
      expect(isValidVersionPrefix("ghijklmn")).toBe(false);
    });
  });

  describe("parseComposeReference", () => {
    it("should parse name-only references", () => {
      const result = parseComposeReference("my-agent");
      expect(result).toEqual({ name: "my-agent", version: undefined });
    });

    it("should parse name:version references", () => {
      const result = parseComposeReference("my-agent:abc12345");
      expect(result).toEqual({ name: "my-agent", version: "abc12345" });
    });

    it("should parse name:latest references", () => {
      const result = parseComposeReference("my-agent:latest");
      expect(result).toEqual({ name: "my-agent", version: "latest" });
    });

    it("should handle full SHA-256 hash as version", () => {
      const fullHash = "a".repeat(64);
      const result = parseComposeReference(`my-agent:${fullHash}`);
      expect(result).toEqual({ name: "my-agent", version: fullHash });
    });

    it("should use last colon for splitting (handle colons in name)", () => {
      const result = parseComposeReference("scope:name:version");
      expect(result).toEqual({ name: "scope:name", version: "version" });
    });

    it("should treat empty version as part of name", () => {
      const result = parseComposeReference("my-agent:");
      expect(result).toEqual({ name: "my-agent:", version: undefined });
    });

    it("should handle names without colons", () => {
      const result = parseComposeReference("simple-name");
      expect(result).toEqual({ name: "simple-name", version: undefined });
    });
  });
});
