import { describe, it, expect, vi } from "vitest";
import { gatherConfiguration } from "../gather-configuration";

/**
 * Create mock prompt dependencies for testing.
 * Uses dependency injection instead of vi.mock() to avoid AP-4 violation
 * (mocking internal code).
 */
function createMockDeps(
  overrides: {
    isInteractive?: boolean;
    promptConfirm?: boolean | boolean[];
    promptPassword?: string | string[];
    promptText?: string | string[];
  } = {},
) {
  let confirmIndex = 0;
  let passwordIndex = 0;
  let textIndex = 0;

  const confirmValues = Array.isArray(overrides.promptConfirm)
    ? overrides.promptConfirm
    : [overrides.promptConfirm ?? false];
  const passwordValues = Array.isArray(overrides.promptPassword)
    ? overrides.promptPassword
    : [overrides.promptPassword ?? ""];
  const textValues = Array.isArray(overrides.promptText)
    ? overrides.promptText
    : [overrides.promptText ?? ""];

  return {
    isInteractive: vi.fn(() => overrides.isInteractive ?? true),
    promptConfirm: vi.fn(async () => {
      const value =
        confirmValues[confirmIndex] ?? confirmValues[confirmValues.length - 1];
      confirmIndex++;
      return value ?? false;
    }),
    promptPassword: vi.fn(async () => {
      const value =
        passwordValues[passwordIndex] ??
        passwordValues[passwordValues.length - 1];
      passwordIndex++;
      return value ?? "";
    }),
    promptText: vi.fn(async () => {
      const value = textValues[textIndex] ?? textValues[textValues.length - 1];
      textIndex++;
      return value ?? "";
    }),
  };
}

describe("gatherConfiguration", () => {
  describe("new schedule scenarios", () => {
    it("should use --secret flag values for new schedule", async () => {
      const deps = createMockDeps({ isInteractive: true });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: ["API_KEY=my-secret-value"],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.secrets).toEqual({ API_KEY: "my-secret-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      // Should not prompt when --secret flag is provided
      expect(deps.promptPassword).not.toHaveBeenCalled();
    });

    it("should prompt for secrets interactively for new schedule (THE BUG FIX)", async () => {
      // This is the bug scenario: new schedule, no --secret flag, required secrets
      const deps = createMockDeps({
        isInteractive: true,
        promptPassword: "entered-value",
      });

      const result = await gatherConfiguration(
        {
          required: {
            secrets: ["FIRECRAWL_API_KEY"],
            vars: [],
            credentials: [],
          },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined, // New schedule - no existing secrets
        },
        deps,
      );

      // The fix: secrets should be gathered and sent, not discarded
      expect(result.secrets).toEqual({ FIRECRAWL_API_KEY: "entered-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      expect(deps.promptPassword).toHaveBeenCalledTimes(1);
    });

    it("should not prompt in non-interactive mode for new schedule", async () => {
      const deps = createMockDeps({ isInteractive: false });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      // Non-interactive: return what we have, server will validate
      expect(result.secrets).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
      expect(deps.promptPassword).not.toHaveBeenCalled();
    });
  });

  describe("update schedule scenarios", () => {
    it("should preserve existing secrets when user chooses to keep them", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptConfirm: true,
      });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: {
            secretNames: ["API_KEY"],
            vars: null,
          },
        },
        deps,
      );

      expect(result.secrets).toEqual({});
      expect(result.preserveExistingSecrets).toBe(true);
      expect(deps.promptConfirm).toHaveBeenCalledWith(
        "Keep existing secrets? (API_KEY)",
        true,
      );
      // Should not prompt for password when keeping existing
      expect(deps.promptPassword).not.toHaveBeenCalled();
    });

    it("should prompt for new secrets when user chooses to replace", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptConfirm: false,
        promptPassword: "new-value",
      });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: {
            secretNames: ["API_KEY"],
            vars: null,
          },
        },
        deps,
      );

      expect(result.secrets).toEqual({ API_KEY: "new-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      expect(deps.promptPassword).toHaveBeenCalledTimes(1);
    });

    it("should use --secret flag to override existing secrets", async () => {
      const deps = createMockDeps({ isInteractive: true });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: ["API_KEY=new-from-flag"],
          optionVars: [],
          existingSchedule: {
            secretNames: ["API_KEY"],
            vars: null,
          },
        },
        deps,
      );

      expect(result.secrets).toEqual({ API_KEY: "new-from-flag" });
      expect(result.preserveExistingSecrets).toBe(false);
      // Should not prompt when --secret flag is provided
      expect(deps.promptConfirm).not.toHaveBeenCalled();
    });
  });

  describe("vars handling", () => {
    it("should keep existing vars when user chooses to", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptConfirm: true,
      });

      const result = await gatherConfiguration(
        {
          required: { secrets: [], vars: ["ENV"], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: {
            secretNames: null,
            vars: { ENV: "production" },
          },
        },
        deps,
      );

      expect(result.vars).toEqual({ ENV: "production" });
    });

    it("should prompt for missing vars for new schedule", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptText: "https://api.example.com",
      });

      const result = await gatherConfiguration(
        {
          required: { secrets: [], vars: ["API_URL"], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.vars).toEqual({ API_URL: "https://api.example.com" });
      expect(deps.promptText).toHaveBeenCalledTimes(1);
    });

    it("should use --var flag values", async () => {
      const deps = createMockDeps({ isInteractive: true });

      const result = await gatherConfiguration(
        {
          required: { secrets: [], vars: ["ENV"], credentials: [] },
          optionSecrets: [],
          optionVars: ["ENV=staging"],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.vars).toEqual({ ENV: "staging" });
      expect(deps.promptText).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("should handle empty required configuration", async () => {
      const deps = createMockDeps({ isInteractive: true });

      const result = await gatherConfiguration(
        {
          required: { secrets: [], vars: [], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.secrets).toEqual({});
      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
    });

    it("should handle multiple secrets and vars", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptPassword: ["secret1-value", "secret2-value"],
        promptText: "var-value",
      });

      const result = await gatherConfiguration(
        {
          required: {
            secrets: ["SECRET1", "SECRET2"],
            vars: ["VAR1"],
            credentials: [],
          },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.secrets).toEqual({
        SECRET1: "secret1-value",
        SECRET2: "secret2-value",
      });
      expect(result.vars).toEqual({ VAR1: "var-value" });
    });

    it("should skip prompting for secrets that are already provided", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptPassword: "prompted-value",
      });

      const result = await gatherConfiguration(
        {
          required: {
            secrets: ["PROVIDED_SECRET", "MISSING_SECRET"],
            vars: [],
            credentials: [],
          },
          optionSecrets: ["PROVIDED_SECRET=from-flag"],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.secrets).toEqual({
        PROVIDED_SECRET: "from-flag",
        MISSING_SECRET: "prompted-value",
      });
      // Should only prompt for the missing secret
      expect(deps.promptPassword).toHaveBeenCalledTimes(1);
    });
  });
});
