/**
 * Tests for zero web upload-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend uploads route via MSW
 * - Real (internal): All CLI code, FormData, fetch, filesystem reads
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const UPLOAD_URL = "http://localhost:3000/api/zero/uploads";

describe("zero web upload-file command", () => {
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

    tmpDir = join(tmpdir(), `web-upload-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("successful upload", () => {
    it("should POST multipart form-data with inferred MIME and print JSON result", async () => {
      const filePath = join(tmpDir, "report.pdf");
      writeFileSync(filePath, Buffer.from("%PDF-1.4 fake"));

      const responseBody = {
        id: "file-uuid-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 14,
        url: "https://presigned.example.com/file-uuid-1/report.pdf?sig=abc",
      };

      server.use(
        http.post(UPLOAD_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          const contentType = request.headers.get("content-type") ?? "";
          expect(contentType).toContain("multipart/form-data");

          const formData = await request.formData();
          const file = formData.get("file");
          expect(file).toBeInstanceOf(File);
          if (file instanceof File) {
            expect(file.name).toBe("report.pdf");
            expect(file.type).toBe("application/pdf");
          }

          return HttpResponse.json(responseBody, { status: 200 });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject(responseBody);
    });

    it("should respect --content-type override", async () => {
      const filePath = join(tmpDir, "data.bin");
      writeFileSync(filePath, Buffer.from("col1,col2\n1,2"));

      server.use(
        http.post(UPLOAD_URL, async ({ request }) => {
          const formData = await request.formData();
          const file = formData.get("file");
          expect(file).toBeInstanceOf(File);
          if (file instanceof File) {
            expect(file.type).toBe("text/csv");
          }

          return HttpResponse.json(
            {
              id: "csv-uuid",
              filename: "data.bin",
              contentType: "text/csv",
              size: 13,
              url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
            },
            { status: 200 },
          );
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--content-type",
        "text/csv",
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe("text/csv");
    });
  });

  describe("validation errors", () => {
    it("should throw when the file does not exist", async () => {
      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "-f",
          join(tmpDir, "missing.txt"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("API errors", () => {
    it("should surface 401 unauthorized", async () => {
      const filePath = join(tmpDir, "hello.txt");
      writeFileSync(filePath, "hi");

      server.use(
        http.post(UPLOAD_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should surface 400 file too large", async () => {
      const filePath = join(tmpDir, "big.txt");
      writeFileSync(filePath, "small");

      server.use(
        http.post(UPLOAD_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "File too large (max 10 MB)",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File too large"),
      );
    });
  });
});
