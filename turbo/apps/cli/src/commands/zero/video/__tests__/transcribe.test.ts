/**
 * Tests for zero video transcribe command.
 *
 * Uses MSW to mock the STT API endpoint and child_process.execFileSync
 * to avoid requiring real ffmpeg/curl in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { transcribeCommand } from "../transcribe";

const STT_URL = "http://localhost:3000/api/zero/voice-io/stt";

vi.mock("child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue(Buffer.from("fake audio data")),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
    unlinkSync: vi.fn(),
  };
});

vi.mock("../../../../lib/api/domains/web", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/api/domains/web")>();
  return {
    ...actual,
    downloadWebFile: vi.fn().mockResolvedValue({
      path: "/tmp/zero-video-test.mp4",
      mimetype: "video/mp4",
      size: 1024,
    }),
  };
});

const mockStdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => {
    return true;
  });

describe("zero video transcribe command", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    mockStdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("with timestamps (verbose mode)", () => {
    it("should output structured Markdown with timestamp blocks", async () => {
      server.use(
        http.post(STT_URL, () => {
          return HttpResponse.json({
            text: "Hello world. Second sentence.",
            segments: [
              { start: 2.52, end: 5.36, text: " Hello world." },
              { start: 6.08, end: 7.4, text: " Second sentence." },
            ],
          });
        }),
      );

      await transcribeCommand.parseAsync(
        ["--url", "https://example.com/video.mp4"],
        { from: "user" },
      );

      const output = mockStdoutWrite.mock.calls
        .map((c) => {
          return c[0];
        })
        .join("");
      expect(output).toContain("## Transcript");
      expect(output).toContain("[00:02-00:05] Hello world.");
      expect(output).toContain("[00:06-00:07] Second sentence.");
    });
  });

  describe("without timestamps (--no-timestamps)", () => {
    it("should output plain text transcript", async () => {
      server.use(
        http.post(STT_URL, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("verbose")).toBeNull();
          return HttpResponse.json({
            text: "Hello world. Second sentence.",
          });
        }),
      );

      await transcribeCommand.parseAsync(
        ["--url", "https://example.com/video.mp4", "--no-timestamps"],
        { from: "user" },
      );

      const output = mockStdoutWrite.mock.calls
        .map((c) => {
          return c[0];
        })
        .join("");
      expect(output).toContain("## Transcript");
      expect(output).toContain("Hello world. Second sentence.");
      expect(output).not.toMatch(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/);
    });
  });

  describe("with --file-id", () => {
    it("should use downloadWebFile instead of curl", async () => {
      const { downloadWebFile } = await import(
        "../../../../lib/api/domains/web"
      );

      server.use(
        http.post(STT_URL, () => {
          return HttpResponse.json({ text: "File content." });
        }),
      );

      await transcribeCommand.parseAsync(["--file-id", "abc-123-def"], {
        from: "user",
      });

      expect(downloadWebFile).toHaveBeenCalledWith(
        "abc-123-def",
        expect.stringContaining("zero-video-"),
      );
    });
  });

  describe("missing arguments", () => {
    it("should exit with error when neither --url nor --file-id provided", async () => {
      const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(
        transcribeCommand.parseAsync([], { from: "user" }),
      ).rejects.toThrow("process.exit called");

      mockExit.mockRestore();
    });
  });
});
