/**
 * Tests for zero teams download-file command.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { downloadFileCommand } from "../download-file";

const DOWNLOAD_URL =
  "http://localhost:3000/api/zero/integrations/teams/download-file";

describe("zero teams download-file command", () => {
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
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `teams-download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams file bytes to the provided output path and prints JSON result", async () => {
    const payload = Buffer.from("hello teams");
    const outPath = join(tmpDir, "result.png");

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("file_id")).toBe("teams-file-id");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
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
      "teams-file-id",
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

  it("surfaces API errors", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Invalid Microsoft Teams file id",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await downloadFileCommand.parseAsync([
        "node",
        "cli",
        "bad-id",
        "-o",
        join(tmpDir, "bad.bin"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Invalid Microsoft Teams file id"),
    );
  });
});
