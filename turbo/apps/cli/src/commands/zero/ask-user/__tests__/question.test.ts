/**
 * Tests for zero ask-user question command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { questionCommand } from "../question";
import chalk from "chalk";

const QUESTION_URL = "http://localhost:3000/api/zero/ask-user/question";
const ANSWER_URL = "http://localhost:3000/api/zero/ask-user/answer";

const PENDING_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("zero ask-user question command", () => {
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

  describe("happy path", () => {
    it("should post question and print answer when answered immediately", async () => {
      server.use(
        http.post(QUESTION_URL, () => {
          return HttpResponse.json({ pendingId: PENDING_ID }, { status: 200 });
        }),
        http.get(ANSWER_URL, () => {
          return HttpResponse.json(
            { status: "answered", answer: "yes" },
            { status: 200 },
          );
        }),
      );

      await questionCommand.parseAsync([
        "node",
        "cli",
        "Do you approve?",
        "--option",
        "Yes",
        "--option",
        "No",
        "--timeout",
        "5",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith("yes");
    });

    it("should post question with options and header", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(QUESTION_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ pendingId: PENDING_ID }, { status: 200 });
        }),
        http.get(ANSWER_URL, () => {
          return HttpResponse.json(
            { status: "answered", answer: "Option A" },
            { status: 200 },
          );
        }),
      );

      await questionCommand.parseAsync([
        "node",
        "cli",
        "Pick one",
        "--header",
        "Choice",
        "--option",
        "Option A",
        "--desc",
        "First option",
        "--option",
        "Option B",
        "--desc",
        "Second option",
      ]);

      expect(capturedBody).toMatchObject({
        questions: [
          {
            question: "Pick one",
            header: "Choice",
            options: [
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
            ],
          },
        ],
      });
      expect(mockConsoleLog).toHaveBeenCalledWith("Option A");
    });

    it("should poll until answer is available", async () => {
      let pollCount = 0;

      server.use(
        http.post(QUESTION_URL, () => {
          return HttpResponse.json({ pendingId: PENDING_ID }, { status: 200 });
        }),
        http.get(ANSWER_URL, () => {
          pollCount++;
          if (pollCount < 3) {
            return HttpResponse.json({ status: "pending" }, { status: 200 });
          }
          return HttpResponse.json(
            { status: "answered", answer: "done" },
            { status: 200 },
          );
        }),
      );

      await questionCommand.parseAsync([
        "node",
        "cli",
        "Are you done?",
        "--option",
        "Yes",
        "--option",
        "No",
        "--timeout",
        "10",
      ]);

      expect(pollCount).toBe(3);
      expect(mockConsoleLog).toHaveBeenCalledWith("done");
    });
  });

  describe("error handling", () => {
    it("should throw error when question expires", async () => {
      server.use(
        http.post(QUESTION_URL, () => {
          return HttpResponse.json({ pendingId: PENDING_ID }, { status: 200 });
        }),
        http.get(ANSWER_URL, () => {
          return HttpResponse.json({ status: "expired" }, { status: 200 });
        }),
      );

      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Will you respond?",
          "--option",
          "Yes",
          "--timeout",
          "5",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Question expired before user responded"),
      );
    });

    it("should throw error when timeout is reached", async () => {
      server.use(
        http.post(QUESTION_URL, () => {
          return HttpResponse.json({ pendingId: PENDING_ID }, { status: 200 });
        }),
        http.get(ANSWER_URL, () => {
          return HttpResponse.json({ status: "pending" }, { status: 200 });
        }),
      );

      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Will you respond?",
          "--option",
          "Yes",
          "--timeout",
          "2",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Timed out waiting for user response after 2s"),
      );
    });

    it("should error when no --option flags provided", async () => {
      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Pick one",
          "--timeout",
          "5",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("At least one --option is required"),
      );
    });

    it("should error when --timeout is not a positive number", async () => {
      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Pick one",
          "--option",
          "Yes",
          "--timeout",
          "0",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "--timeout must be a positive number of seconds",
        ),
      );
    });

    it("should error when --desc is provided without matching --option", async () => {
      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Pick one",
          "--desc",
          "orphan description",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--desc must follow an --option flag"),
      );
    });

    it("should handle API authentication error", async () => {
      server.use(
        http.post(QUESTION_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await questionCommand.parseAsync([
          "node",
          "cli",
          "Any question",
          "--option",
          "OK",
          "--timeout",
          "5",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
