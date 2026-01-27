import { describe, it, expect, vi, beforeEach } from "vitest";
import { gatherConfiguration } from "../gather-configuration";
import * as promptUtils from "../../../lib/utils/prompt-utils";

// Mock prompt utilities
vi.mock("../../../lib/utils/prompt-utils", () => ({
  isInteractive: vi.fn(),
  promptConfirm: vi.fn(),
  promptPassword: vi.fn(),
  promptText: vi.fn(),
}));

describe("gatherConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("new schedule scenarios", () => {
    it("should use --secret flag values for new schedule", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);

      const result = await gatherConfiguration({
        required: { secrets: ["API_KEY"], vars: [], credentials: [] },
        optionSecrets: ["API_KEY=my-secret-value"],
        optionVars: [],
        existingSchedule: undefined,
      });

      expect(result.secrets).toEqual({ API_KEY: "my-secret-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      // Should not prompt when --secret flag is provided
      expect(promptUtils.promptPassword).not.toHaveBeenCalled();
    });

    it("should prompt for secrets interactively for new schedule (THE BUG FIX)", async () => {
      // This is the bug scenario: new schedule, no --secret flag, required secrets
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptPassword).mockResolvedValue("entered-value");

      const result = await gatherConfiguration({
        required: { secrets: ["FIRECRAWL_API_KEY"], vars: [], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: undefined, // New schedule - no existing secrets
      });

      // The fix: secrets should be gathered and sent, not discarded
      expect(result.secrets).toEqual({ FIRECRAWL_API_KEY: "entered-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      expect(promptUtils.promptPassword).toHaveBeenCalledTimes(1);
    });

    it("should not prompt in non-interactive mode for new schedule", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(false);

      const result = await gatherConfiguration({
        required: { secrets: ["API_KEY"], vars: [], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: undefined,
      });

      // Non-interactive: return what we have, server will validate
      expect(result.secrets).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
      expect(promptUtils.promptPassword).not.toHaveBeenCalled();
    });
  });

  describe("update schedule scenarios", () => {
    it("should preserve existing secrets when user chooses to keep them", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(true);

      const result = await gatherConfiguration({
        required: { secrets: ["API_KEY"], vars: [], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: {
          secretNames: ["API_KEY"],
          vars: null,
        },
      });

      expect(result.secrets).toEqual({});
      expect(result.preserveExistingSecrets).toBe(true);
      expect(promptUtils.promptConfirm).toHaveBeenCalledWith(
        "Keep existing secrets? (API_KEY)",
        true,
      );
      // Should not prompt for password when keeping existing
      expect(promptUtils.promptPassword).not.toHaveBeenCalled();
    });

    it("should prompt for new secrets when user chooses to replace", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false);
      vi.mocked(promptUtils.promptPassword).mockResolvedValue("new-value");

      const result = await gatherConfiguration({
        required: { secrets: ["API_KEY"], vars: [], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: {
          secretNames: ["API_KEY"],
          vars: null,
        },
      });

      expect(result.secrets).toEqual({ API_KEY: "new-value" });
      expect(result.preserveExistingSecrets).toBe(false);
      expect(promptUtils.promptPassword).toHaveBeenCalledTimes(1);
    });

    it("should use --secret flag to override existing secrets", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);

      const result = await gatherConfiguration({
        required: { secrets: ["API_KEY"], vars: [], credentials: [] },
        optionSecrets: ["API_KEY=new-from-flag"],
        optionVars: [],
        existingSchedule: {
          secretNames: ["API_KEY"],
          vars: null,
        },
      });

      expect(result.secrets).toEqual({ API_KEY: "new-from-flag" });
      expect(result.preserveExistingSecrets).toBe(false);
      // Should not prompt when --secret flag is provided
      expect(promptUtils.promptConfirm).not.toHaveBeenCalled();
    });
  });

  describe("vars handling", () => {
    it("should keep existing vars when user chooses to", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(true);

      const result = await gatherConfiguration({
        required: { secrets: [], vars: ["ENV"], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: {
          secretNames: null,
          vars: { ENV: "production" },
        },
      });

      expect(result.vars).toEqual({ ENV: "production" });
    });

    it("should prompt for missing vars for new schedule", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptText).mockResolvedValue(
        "https://api.example.com",
      );

      const result = await gatherConfiguration({
        required: { secrets: [], vars: ["API_URL"], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: undefined,
      });

      expect(result.vars).toEqual({ API_URL: "https://api.example.com" });
      expect(promptUtils.promptText).toHaveBeenCalledTimes(1);
    });

    it("should use --var flag values", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);

      const result = await gatherConfiguration({
        required: { secrets: [], vars: ["ENV"], credentials: [] },
        optionSecrets: [],
        optionVars: ["ENV=staging"],
        existingSchedule: undefined,
      });

      expect(result.vars).toEqual({ ENV: "staging" });
      expect(promptUtils.promptText).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("should handle empty required configuration", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);

      const result = await gatherConfiguration({
        required: { secrets: [], vars: [], credentials: [] },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: undefined,
      });

      expect(result.secrets).toEqual({});
      expect(result.vars).toEqual({});
      expect(result.preserveExistingSecrets).toBe(false);
    });

    it("should handle multiple secrets and vars", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptPassword)
        .mockResolvedValueOnce("secret1-value")
        .mockResolvedValueOnce("secret2-value");
      vi.mocked(promptUtils.promptText).mockResolvedValue("var-value");

      const result = await gatherConfiguration({
        required: {
          secrets: ["SECRET1", "SECRET2"],
          vars: ["VAR1"],
          credentials: [],
        },
        optionSecrets: [],
        optionVars: [],
        existingSchedule: undefined,
      });

      expect(result.secrets).toEqual({
        SECRET1: "secret1-value",
        SECRET2: "secret2-value",
      });
      expect(result.vars).toEqual({ VAR1: "var-value" });
    });

    it("should skip prompting for secrets that are already provided", async () => {
      vi.mocked(promptUtils.isInteractive).mockReturnValue(true);
      vi.mocked(promptUtils.promptPassword).mockResolvedValue("prompted-value");

      const result = await gatherConfiguration({
        required: {
          secrets: ["PROVIDED_SECRET", "MISSING_SECRET"],
          vars: [],
          credentials: [],
        },
        optionSecrets: ["PROVIDED_SECRET=from-flag"],
        optionVars: [],
        existingSchedule: undefined,
      });

      expect(result.secrets).toEqual({
        PROVIDED_SECRET: "from-flag",
        MISSING_SECRET: "prompted-value",
      });
      // Should only prompt for the missing secret
      expect(promptUtils.promptPassword).toHaveBeenCalledTimes(1);
    });
  });
});
