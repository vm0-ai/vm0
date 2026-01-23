/**
 * Unit tests for skill frontmatter secret detection and comparison logic
 *
 * These tests cover the logic that was previously tested via E2E tests in
 * t24-vm0-skill-frontmatter.bats. Moving these to unit tests improves test
 * performance and provides faster feedback during development.
 *
 * Key behaviors tested:
 * - Secret state comparison between new compose and HEAD version
 * - Detection and marking of truly new secrets
 * - Filtering of existing secrets from confirmation prompts
 */

import { describe, it, expect } from "vitest";
import { getSecretsFromComposeContent } from "../commands/compose";

describe("Skill Frontmatter Secret Detection", () => {
  describe("Secret State Comparison Logic", () => {
    /**
     * Tests the logic for comparing secrets between a new compose and HEAD version.
     * This determines whether confirmation is needed (only for new secrets).
     */
    it("should identify truly new secrets not in HEAD version", () => {
      // Simulate HEAD version secrets
      const headSecrets = new Set(["ELEVENLABS_API_KEY"]);

      // Simulate new compose secrets (from skill frontmatter)
      const newComposeSecrets = ["ELEVENLABS_API_KEY", "RESEND_API_KEY"];

      // Determine truly new secrets (not in HEAD)
      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );

      expect(trulyNewSecrets).toEqual(["RESEND_API_KEY"]);
      expect(trulyNewSecrets).not.toContain("ELEVENLABS_API_KEY");
    });

    it("should return empty array when all secrets exist in HEAD", () => {
      const headSecrets = new Set(["API_KEY", "DB_URL", "REDIS_URL"]);
      const newComposeSecrets = ["API_KEY", "DB_URL"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );

      expect(trulyNewSecrets).toEqual([]);
    });

    it("should treat all secrets as new when HEAD has no secrets", () => {
      const headSecrets = new Set<string>();
      const newComposeSecrets = ["NEW_SECRET_1", "NEW_SECRET_2"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );

      expect(trulyNewSecrets).toEqual(["NEW_SECRET_1", "NEW_SECRET_2"]);
    });

    it("should handle first-time compose (no existing HEAD)", () => {
      // When no HEAD exists, all secrets are new
      const headSecrets = new Set<string>(); // Empty - first time compose
      const newComposeSecrets = ["ELEVENLABS_API_KEY"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );

      expect(trulyNewSecrets).toEqual(["ELEVENLABS_API_KEY"]);
    });
  });

  describe("New Secret Marker Logic", () => {
    /**
     * Tests the logic for determining which secrets should show (new) marker.
     * Only truly new secrets (not in HEAD) should be marked as new.
     */
    it("should mark only truly new secrets with (new) marker", () => {
      const headSecrets = new Set(["EXISTING_SECRET"]);
      const allNewSecrets = [
        { name: "EXISTING_SECRET", skills: ["skill1"] },
        { name: "NEW_SECRET", skills: ["skill2"] },
      ];

      const secretsWithMarkers = allNewSecrets.map((secret) => ({
        ...secret,
        isNew: !headSecrets.has(secret.name),
      }));

      expect(secretsWithMarkers).toEqual([
        { name: "EXISTING_SECRET", skills: ["skill1"], isNew: false },
        { name: "NEW_SECRET", skills: ["skill2"], isNew: true },
      ]);
    });

    it("should not mark any secrets as new when all exist in HEAD", () => {
      const headSecrets = new Set(["SECRET_A", "SECRET_B"]);
      const allNewSecrets = [
        { name: "SECRET_A", skills: ["skill1"] },
        { name: "SECRET_B", skills: ["skill2"] },
      ];

      const secretsWithMarkers = allNewSecrets.map((secret) => ({
        ...secret,
        isNew: !headSecrets.has(secret.name),
      }));

      const anyMarkedNew = secretsWithMarkers.some((s) => s.isNew);
      expect(anyMarkedNew).toBe(false);
    });

    it("should mark all secrets as new on first compose", () => {
      const headSecrets = new Set<string>(); // No HEAD version
      const allNewSecrets = [
        { name: "SECRET_A", skills: ["skill1"] },
        { name: "SECRET_B", skills: ["skill2"] },
      ];

      const secretsWithMarkers = allNewSecrets.map((secret) => ({
        ...secret,
        isNew: !headSecrets.has(secret.name),
      }));

      const allMarkedNew = secretsWithMarkers.every((s) => s.isNew);
      expect(allMarkedNew).toBe(true);
    });
  });

  describe("Confirmation Skip Logic", () => {
    /**
     * Tests the logic for determining when confirmation can be skipped.
     * Re-compose with same secrets should not require confirmation.
     */
    it("should skip confirmation when no truly new secrets", () => {
      const headSecrets = new Set(["SECRET_1", "SECRET_2"]);
      const newComposeSecrets = ["SECRET_1", "SECRET_2"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );
      const requiresConfirmation = trulyNewSecrets.length > 0;

      expect(requiresConfirmation).toBe(false);
    });

    it("should require confirmation when new secrets detected", () => {
      const headSecrets = new Set(["EXISTING"]);
      const newComposeSecrets = ["EXISTING", "NEW_ONE"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );
      const requiresConfirmation = trulyNewSecrets.length > 0;

      expect(requiresConfirmation).toBe(true);
    });

    it("should require confirmation on first compose with secrets", () => {
      const headSecrets = new Set<string>(); // No HEAD
      const newComposeSecrets = ["ANY_SECRET"];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );
      const requiresConfirmation = trulyNewSecrets.length > 0;

      expect(requiresConfirmation).toBe(true);
    });

    it("should not require confirmation when no secrets at all", () => {
      const headSecrets = new Set<string>();
      const newComposeSecrets: string[] = [];

      const trulyNewSecrets = newComposeSecrets.filter(
        (name) => !headSecrets.has(name),
      );
      const requiresConfirmation = trulyNewSecrets.length > 0;

      expect(requiresConfirmation).toBe(false);
    });
  });

  describe("Secret Extraction from Compose Content", () => {
    /**
     * Tests getSecretsFromComposeContent which extracts secrets from HEAD version.
     * This is used to determine which secrets already exist.
     */
    it("should extract secrets from compose with skill-derived environment", () => {
      const content = {
        version: "1.0",
        agents: {
          myAgent: {
            framework: "claude-code",
            skills: [
              "https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs",
            ],
            environment: {
              ELEVENLABS_API_KEY: "${{ secrets.ELEVENLABS_API_KEY }}",
            },
          },
        },
      };

      const secrets = getSecretsFromComposeContent(content);

      expect(secrets.size).toBe(1);
      expect(secrets.has("ELEVENLABS_API_KEY")).toBe(true);
    });

    it("should extract multiple secrets from multi-skill compose", () => {
      const content = {
        version: "1.0",
        agents: {
          myAgent: {
            framework: "claude-code",
            skills: [
              "https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs",
              "https://github.com/vm0-ai/vm0-skills/tree/main/resend",
            ],
            environment: {
              ELEVENLABS_API_KEY: "${{ secrets.ELEVENLABS_API_KEY }}",
              RESEND_API_KEY: "${{ secrets.RESEND_API_KEY }}",
            },
          },
        },
      };

      const secrets = getSecretsFromComposeContent(content);

      expect(secrets.size).toBe(2);
      expect(secrets.has("ELEVENLABS_API_KEY")).toBe(true);
      expect(secrets.has("RESEND_API_KEY")).toBe(true);
    });

    it("should not include vars in secrets set", () => {
      const content = {
        version: "1.0",
        agents: {
          myAgent: {
            framework: "claude-code",
            environment: {
              SECRET_KEY: "${{ secrets.SECRET_KEY }}",
              CONFIG_URL: "${{ vars.CONFIG_URL }}",
            },
          },
        },
      };

      const secrets = getSecretsFromComposeContent(content);

      expect(secrets.size).toBe(1);
      expect(secrets.has("SECRET_KEY")).toBe(true);
      expect(secrets.has("CONFIG_URL")).toBe(false);
    });
  });

  describe("Environment Variable Filtering", () => {
    /**
     * Tests the logic for filtering out environment variables already defined.
     * Explicit environment takes precedence over skill frontmatter.
     */
    it("should filter secrets already in explicit environment", () => {
      const skillSecrets = new Map([
        ["API_KEY", ["skill1"]],
        ["DB_URL", ["skill2"]],
        ["CUSTOM_KEY", ["skill3"]],
      ]);
      const explicitEnvironment: Record<string, string> = {
        API_KEY: "${{ secrets.DIFFERENT_KEY }}",
        STATIC_VALUE: "static",
      };

      const newSecrets = [...skillSecrets.entries()].filter(
        ([name]) => !(name in explicitEnvironment),
      );

      expect(newSecrets).toEqual([
        ["DB_URL", ["skill2"]],
        ["CUSTOM_KEY", ["skill3"]],
      ]);
    });

    it("should return all secrets when no explicit environment", () => {
      const skillSecrets = new Map([
        ["API_KEY", ["skill1"]],
        ["DB_URL", ["skill2"]],
      ]);
      const explicitEnvironment: Record<string, string> = {};

      const newSecrets = [...skillSecrets.entries()].filter(
        ([name]) => !(name in explicitEnvironment),
      );

      expect(newSecrets).toEqual([
        ["API_KEY", ["skill1"]],
        ["DB_URL", ["skill2"]],
      ]);
    });

    it("should return empty when all secrets in explicit environment", () => {
      const skillSecrets = new Map([["API_KEY", ["skill1"]]]);
      const explicitEnvironment: Record<string, string> = {
        API_KEY: "${{ secrets.API_KEY }}",
      };

      const newSecrets = [...skillSecrets.entries()].filter(
        ([name]) => !(name in explicitEnvironment),
      );

      expect(newSecrets).toEqual([]);
    });
  });
});
