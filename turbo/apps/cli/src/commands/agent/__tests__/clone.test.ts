/**
 * Tests for agent clone command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { cloneCommand } from "../clone";

describe("agent clone command", () => {
  let tempDir: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-clone-test-"));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("successful clone", () => {
    it("should clone compose without instructions", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      // Verify vm0.yaml was created
      expect(fs.existsSync(path.join(dest, "vm0.yaml"))).toBe(true);

      // Verify YAML content
      const yamlContent = fs.readFileSync(path.join(dest, "vm0.yaml"), "utf8");
      expect(yamlContent).toContain("version:");
      expect(yamlContent).toContain("framework: claude-code");

      // Verify success message
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Successfully cloned agent: test-agent");
      expect(logCalls).toContain("Created vm0.yaml");
    });

    it("should use agent name as default destination", async () => {
      // Create a unique subdirectory for this test to use as working directory
      const workDir = path.join(tempDir, "workdir");
      fs.mkdirSync(workDir);
      const originalCwd = process.cwd();

      try {
        process.chdir(workDir);

        server.use(
          http.get(
            "http://localhost:3000/api/agent/composes",
            ({ request }) => {
              const url = new URL(request.url);
              if (url.searchParams.get("name") === "my-agent") {
                return HttpResponse.json({
                  id: "cmp-123",
                  name: "my-agent",
                  headVersionId:
                    "abc123def456789012345678901234567890123456789012345678901234",
                  content: {
                    version: "1",
                    agents: {
                      "my-agent": {
                        framework: "claude-code",
                      },
                    },
                  },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              }
              return HttpResponse.json(
                { error: { message: "Not found", code: "NOT_FOUND" } },
                { status: 400 },
              );
            },
          ),
        );

        await cloneCommand.parseAsync(["node", "cli", "my-agent"]);

        // Verify directory was created with agent name
        expect(fs.existsSync(path.join(workDir, "my-agent", "vm0.yaml"))).toBe(
          true,
        );
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should remove deprecated fields from output YAML", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    image: "deprecated-image", // Should be removed
                    working_dir: "/deprecated", // Should be removed
                    description: "My agent",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      const yamlContent = fs.readFileSync(path.join(dest, "vm0.yaml"), "utf8");
      expect(yamlContent).not.toContain("image:");
      expect(yamlContent).not.toContain("working_dir:");
      expect(yamlContent).toContain("description: My agent");
    });

    it("should preserve environment variables", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    environment: {
                      API_KEY: "${{ secrets.API_KEY }}",
                      DEBUG: "${{ vars.DEBUG }}",
                    },
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      const yamlContent = fs.readFileSync(path.join(dest, "vm0.yaml"), "utf8");
      expect(yamlContent).toContain("API_KEY:");
      expect(yamlContent).toContain("secrets.API_KEY");
      expect(yamlContent).toContain("DEBUG:");
      expect(yamlContent).toContain("vars.DEBUG");
    });

    it("should preserve volumes section", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    volumes: ["my-volume:/data"],
                  },
                },
                volumes: {
                  "my-volume": {
                    name: "user-data",
                    version: "latest",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      const yamlContent = fs.readFileSync(path.join(dest, "vm0.yaml"), "utf8");
      expect(yamlContent).toContain("volumes:");
      expect(yamlContent).toContain("my-volume");
    });
  });

  describe("error handling", () => {
    it("should fail when compose not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Compose not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "nonexistent");
      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "nonexistent", dest]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
    });

    it("should fail when destination is not empty", async () => {
      const dest = path.join(tempDir, "existing");
      fs.mkdirSync(dest);
      // Add a file to make directory non-empty
      fs.writeFileSync(path.join(dest, "existing-file.txt"), "content");

      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("is not empty"),
      );
    });

    it("should succeed when destination is empty directory", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      // Create empty directory
      const dest = path.join(tempDir, "empty-dir");
      fs.mkdirSync(dest);

      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      // Verify vm0.yaml was created in the empty directory
      expect(fs.existsSync(path.join(dest, "vm0.yaml"))).toBe(true);

      // Verify success message
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Successfully cloned agent: test-agent");
    });

    it("should fail when compose has no content", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "empty-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "empty-agent",
              headVersionId: null,
              content: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      const dest = path.join(tempDir, "empty-agent");
      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "empty-agent", dest]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("no content"),
      );
    });

    it("should handle authentication error", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      // No token set

      const dest = path.join(tempDir, "test-agent");
      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Clone failed"),
      );
    });
  });

  describe("instructions download", () => {
    it("should warn when instructions volume is empty", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    instructions: "AGENTS.md",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "empty123",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      // Should still succeed with vm0.yaml
      expect(fs.existsSync(path.join(dest, "vm0.yaml"))).toBe(true);

      // Should show warning
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Instructions volume is empty");
    });

    it("should continue when instructions download fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                    instructions: "AGENTS.md",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            { error: { message: "Storage not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      const dest = path.join(tempDir, "test-agent");
      await cloneCommand.parseAsync(["node", "cli", "test-agent", dest]);

      // Should still succeed with vm0.yaml
      expect(fs.existsSync(path.join(dest, "vm0.yaml"))).toBe(true);

      // Should show warning about instructions
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Could not download instructions");
    });
  });
});
