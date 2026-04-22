/**
 * Tests for zero agent create command
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
import { createCommand } from "../create";
import chalk from "chalk";

const mockAgent = {
  agentId: "comp_xyz789",
  displayName: "New Agent",
  description: null,
  sound: null,
  avatarUrl: null,
};

describe("zero agent create command", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  describe("successful create", () => {
    it("should create agent with display name", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/agents", () => {
          return HttpResponse.json(mockAgent, { status: 201 });
        }),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "--display-name",
        "New Agent",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("comp_xyz789");
      expect(logCalls).toContain("created");
      expect(logCalls).toContain(
        "Next steps to authorize connectors for this agent:",
      );
      expect(logCalls).toContain(
        "zero connector search <keyword> --agent comp_xyz789",
      );
      expect(logCalls).toContain(
        "zero connector status <type> --agent comp_xyz789",
      );
    });

    it("should create agent with custom skills and include them in request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/agents",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "--skills",
        "my-skill,other-skill",
        "--display-name",
        "New Agent",
      ]);

      expect(capturedBody?.customSkills).toEqual(["my-skill", "other-skill"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-skill");
      expect(logCalls).toContain("other-skill");
    });

    it("should send preset avatar in request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/agents",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "--display-name",
        "New Agent",
        "--avatar",
        "preset:2",
      ]);

      expect(capturedBody?.avatarUrl).toBe("preset:2");
    });

    it("should compose svg avatar from descriptive flags", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/agents",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockAgent, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "--display-name",
        "New Agent",
        "--avatar-skin",
        "dark",
        "--avatar-hair-color",
        "teal",
        "--avatar-intensity",
        "hyped",
      ]);

      expect(capturedBody?.avatarUrl).toBe("svg:r3s4h1c2f1h");
    });

    describe("with instructions file", () => {
      let instructionsPath: string;

      beforeEach(() => {
        instructionsPath = join(tmpdir(), "test-instructions.md");
        writeFileSync(instructionsPath, "You are a helpful agent.");
      });

      afterEach(() => {
        unlinkSync(instructionsPath);
      });

      it("should create agent and upload instructions content from file", async () => {
        let capturedInstructionsContent: string | undefined;
        server.use(
          http.post("http://localhost:3000/api/zero/agents", () => {
            return HttpResponse.json(mockAgent, { status: 201 });
          }),
          http.put(
            "http://localhost:3000/api/zero/agents/comp_xyz789/instructions",
            async ({ request }) => {
              const body = (await request.json()) as { content: string };
              capturedInstructionsContent = body.content;
              return HttpResponse.json(mockAgent);
            },
          ),
        );

        await createCommand.parseAsync([
          "node",
          "cli",
          "--display-name",
          "New Agent",
          "--instructions-file",
          instructionsPath,
        ]);

        expect(capturedInstructionsContent).toBe("You are a helpful agent.");
        const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
        expect(logCalls).toContain("comp_xyz789");
        expect(logCalls).toContain("created");
      });
    });
  });

  describe("error handling", () => {
    it("should reject invalid avatar preset", async () => {
      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "--display-name",
          "New Agent",
          "--avatar",
          "preset:9",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --avatar"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject invalid avatar skin value", async () => {
      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "--display-name",
          "New Agent",
          "--avatar-skin",
          "purple",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --avatar-skin"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject combining --avatar preset with --avatar-* flags", async () => {
      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "--display-name",
          "New Agent",
          "--avatar",
          "preset:1",
          "--avatar-skin",
          "dark",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cannot be combined"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/agents", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "--display-name",
          "Test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
