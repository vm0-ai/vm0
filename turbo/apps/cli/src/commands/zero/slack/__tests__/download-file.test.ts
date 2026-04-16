/**
 * Tests for zero slack download-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend download route via MSW
 * - Real (internal): All CLI code, fetch streaming, filesystem writes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import chalk from "chalk";

const DOWNLOAD_URL =
  "http://localhost:3000/api/zero/integrations/slack/download-file";

describe("zero slack download-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("successful download", () => {
    it("should stream file bytes to the provided output path and print JSON result", async () => {
      const payload = Buffer.from("hello world");
      const outPath = join(tmpDir, "result.png");

      server.use(
        http.get(DOWNLOAD_URL, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("file_id")).toBe("F123ABC");
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return new HttpResponse(payload, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(payload.length),
              "x-file-mimetype": "image/png",
            },
          });
        }),
      );

      await downloadFileCommand.parseAsync([
        "node",
        "cli",
        "F123ABC",
        "-o",
        outPath,
      ]);

      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath).equals(payload)).toBe(true);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        path: outPath,
        mimetype: "image/png",
        size: payload.length,
      });
    });

    it("should derive default output path when -o is omitted", async () => {
      const payload = Buffer.from("default-path");

      server.use(
        http.get(DOWNLOAD_URL, () => {
          return new HttpResponse(payload, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "x-file-mimetype": "application/octet-stream",
              "content-length": String(payload.length),
            },
          });
        }),
      );

      await downloadFileCommand.parseAsync(["node", "cli", "F-DEFAULT"]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.path).toBe(join(tmpdir(), "slack-F-DEFAULT"));

      // Clean up the default path since the command wrote there
      rmSync(join(tmpdir(), "slack-F-DEFAULT"), { force: true });
    });
  });

  describe("API errors", () => {
    it("should surface 404 not found as an error", async () => {
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Slack file not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await downloadFileCommand.parseAsync([
          "node",
          "cli",
          "F-MISSING",
          "-o",
          join(tmpDir, "missing.bin"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Slack file not found"),
      );
    });

    it("should surface 413 payload too large", async () => {
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "File exceeds maximum size",
                code: "PAYLOAD_TOO_LARGE",
              },
            },
            { status: 413 },
          );
        }),
      );

      await expect(async () => {
        await downloadFileCommand.parseAsync([
          "node",
          "cli",
          "F-BIG",
          "-o",
          join(tmpDir, "big.bin"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File exceeds maximum size"),
      );
    });

    it("should surface 401 unauthorized", async () => {
      server.use(
        http.get(DOWNLOAD_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await downloadFileCommand.parseAsync([
          "node",
          "cli",
          "F1",
          "-o",
          join(tmpDir, "f1.bin"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });
  });
});
