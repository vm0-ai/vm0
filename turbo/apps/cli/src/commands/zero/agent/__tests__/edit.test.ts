/**
 * Tests for zero agent edit command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../../mocks/server";
import { editCommand } from "../edit";
import chalk from "chalk";

const mockAgent = {
  name: "my-agent",
  agentComposeId: "comp_abc123",
  displayName: "My Agent",
  description: null,
  sound: null,
  connectors: ["github"],
};

describe("zero agent edit command", () => {
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

  describe("successful edit", () => {
    it("should preserve existing connectors when --connectors not provided", async () => {
      let capturedBody: { connectors?: string[] } | undefined;
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.put(
          "http://localhost:3000/api/zero/agents/my-agent",
          async ({ request }) => {
            capturedBody = (await request.json()) as { connectors?: string[] };
            return HttpResponse.json({ ...mockAgent, displayName: "Updated" });
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--display-name",
        "Updated",
      ]);

      expect(capturedBody?.connectors).toEqual(["github"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("updated");
    });

    describe("with instructions file", () => {
      let instructionsPath: string;

      beforeEach(() => {
        instructionsPath = join(tmpdir(), "new-instructions.md");
        writeFileSync(instructionsPath, "New instructions");
      });

      afterEach(() => {
        unlinkSync(instructionsPath);
      });

      it("should upload instructions content from file and show success message", async () => {
        let capturedInstructionsContent: string | undefined;
        server.use(
          http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
            return HttpResponse.json(mockAgent);
          }),
          http.put(
            "http://localhost:3000/api/zero/agents/my-agent/instructions",
            async ({ request }) => {
              const body = (await request.json()) as { content: string };
              capturedInstructionsContent = body.content;
              return HttpResponse.json(mockAgent);
            },
          ),
        );

        await editCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--instructions-file",
          instructionsPath,
        ]);

        expect(capturedInstructionsContent).toBe("New instructions");
        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain("updated");
      });
    });
  });

  describe("validation", () => {
    it("should fail when no options provided", async () => {
      await expect(async () => {
        await editCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("At least one option is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/missing", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "missing",
          "--display-name",
          "x",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
