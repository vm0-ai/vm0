import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    promptText?: string | string[];
  } = {},
) {
  let confirmIndex = 0;
  let textIndex = 0;

  const confirmValues = Array.isArray(overrides.promptConfirm)
    ? overrides.promptConfirm
    : [overrides.promptConfirm ?? false];
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
    promptText: vi.fn(async () => {
      const value = textValues[textIndex] ?? textValues[textValues.length - 1];
      textIndex++;
      return value ?? "";
    }),
  };
}

describe("gatherConfiguration", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("new schedule scenarios", () => {
    it("should show guidance for missing secrets (secrets managed via platform)", async () => {
      const deps = createMockDeps({ isInteractive: true });
      const consoleSpy = vi.spyOn(console, "log");

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      // Secrets are not returned - they're managed via platform
      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
      // Should show guidance to use vm0 secret set
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("vm0 secret set API_KEY"),
      );
    });

    it("should ignore --secret flag (backward compat)", async () => {
      const deps = createMockDeps({ isInteractive: true });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: [], credentials: [] },
          optionSecrets: ["API_KEY=my-secret-value"], // Ignored
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      // Secrets from --secret flag are ignored
      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
    });

    it("should not prompt in non-interactive mode for new schedule", async () => {
      const deps = createMockDeps({ isInteractive: false });

      const result = await gatherConfiguration(
        {
          required: { secrets: ["API_KEY"], vars: ["VAR1"], credentials: [] },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      // Non-interactive: return what we have
      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
      expect(deps.promptText).not.toHaveBeenCalled();
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

      expect(result.preserveExistingSecrets).toBe(true);
      expect(deps.promptConfirm).toHaveBeenCalledWith(
        "Keep existing secrets? (API_KEY)",
        true,
      );
    });

    it("should clear existing secrets when user chooses not to keep them", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptConfirm: false,
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

      expect(result.preserveExistingSecrets).toBe(false);
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

      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
    });

    it("should handle multiple vars", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptText: ["value1", "value2"],
      });

      const result = await gatherConfiguration(
        {
          required: {
            secrets: [],
            vars: ["VAR1", "VAR2"],
            credentials: [],
          },
          optionSecrets: [],
          optionVars: [],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.vars).toEqual({ VAR1: "value1", VAR2: "value2" });
    });

    it("should skip prompting for vars that are already provided", async () => {
      const deps = createMockDeps({
        isInteractive: true,
        promptText: "prompted-value",
      });

      const result = await gatherConfiguration(
        {
          required: {
            secrets: [],
            vars: ["PROVIDED_VAR", "MISSING_VAR"],
            credentials: [],
          },
          optionSecrets: [],
          optionVars: ["PROVIDED_VAR=from-flag"],
          existingSchedule: undefined,
        },
        deps,
      );

      expect(result.vars).toEqual({
        PROVIDED_VAR: "from-flag",
        MISSING_VAR: "prompted-value",
      });
      // Should only prompt for the missing var
      expect(deps.promptText).toHaveBeenCalledTimes(1);
    });
  });
});
