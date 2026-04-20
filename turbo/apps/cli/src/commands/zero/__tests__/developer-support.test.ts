/**
 * Tests for zero developer-support command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { zeroDeveloperSupportCommand } from "../developer-support";
import chalk from "chalk";

const ENDPOINT_URL = "http://localhost:3000/api/zero/developer-support";

describe("zero developer-support command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("step 1: consent code request", () => {
    it("should print consent code when --consent-code is not provided", async () => {
      server.use(
        http.post(ENDPOINT_URL, () => {
          return HttpResponse.json({ consentCode: "A7X3" }, { status: 200 });
        }),
      );

      await zeroDeveloperSupportCommand.parseAsync([
        "node",
        "cli",
        "--title",
        "GitHub 403 error",
        "--description",
        "Connector connected but API returns 403",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        "Consent required to share chat history with developers.",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("Code: A7X3");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        "Ask the user to confirm by providing this code.",
      );
    });
  });

  describe("step 2: submit with consent code", () => {
    it("should print reference when valid consent code is provided", async () => {
      server.use(
        http.post(ENDPOINT_URL, () => {
          return HttpResponse.json(
            { reference: "ds-abc12345" },
            { status: 200 },
          );
        }),
      );

      await zeroDeveloperSupportCommand.parseAsync([
        "node",
        "cli",
        "--title",
        "GitHub 403 error",
        "--description",
        "Connector connected but API returns 403",
        "--consent-code",
        "A7X3",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        "Developer support request submitted successfully.",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("Reference: ds-abc12345");
    });
  });

  describe("error handling", () => {
    it("should show error for invalid consent code", async () => {
      server.use(
        http.post(ENDPOINT_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Invalid consent code",
                code: "INVALID_CONSENT_CODE",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await zeroDeveloperSupportCommand.parseAsync([
          "node",
          "cli",
          "--title",
          "Bug report",
          "--description",
          "Something is broken",
          "--consent-code",
          "ZZZZ",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid consent code"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show auth error when not authenticated", async () => {
      server.use(
        http.post(ENDPOINT_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await zeroDeveloperSupportCommand.parseAsync([
          "node",
          "cli",
          "--title",
          "Bug report",
          "--description",
          "Something is broken",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
