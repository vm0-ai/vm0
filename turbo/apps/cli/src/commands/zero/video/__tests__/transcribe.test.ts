/**
 * Tests for zero video transcribe command.
 *
 * Mocks only external boundaries: the curl/ffmpeg binaries (via child_process,
 * not available in CI) and HTTP (via MSW). The fake binaries write real bytes
 * to their output paths (the arg after "-o" for curl, before "-y" for ffmpeg)
 * so the command's real filesystem, real downloadWebFile, and real
 * transcribeAudio code all run unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { transcribeCommand } from "../transcribe";

const STT_URL = "http://localhost:3000/api/zero/voice-io/stt";
const DOWNLOAD_URL = "http://localhost:3000/api/zero/web/download-file";

vi.mock("child_process", async () => {
  const { writeFileSync } = await vi.importActual<typeof import("fs")>("fs");
  return {
    execFileSync: vi.fn((command: string, args: readonly string[]) => {
      if (command === "curl") {
        const i = args.indexOf("-o");
        const outPath = i >= 0 ? args[i + 1] : undefined;
        if (outPath) {
          writeFileSync(outPath, Buffer.from("fake-video-bytes"));
        }
      } else if (command === "ffmpeg") {
        const i = args.indexOf("-y");
        const outPath = i > 0 ? args[i - 1] : undefined;
        if (outPath) {
          writeFileSync(outPath, Buffer.from("fake-audio-bytes"));
        }
      }
      return Buffer.from("");
    }),
  };
});

const mockStdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => {
    return true;
  });

function readStdout(): string {
  return mockStdoutWrite.mock.calls
    .map((c) => {
      return c[0];
    })
    .join("");
}

describe("zero video transcribe command", () => {
  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    mockStdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("with timestamps (verbose mode)", () => {
    it("outputs structured Markdown with timestamp blocks", async () => {
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

      const output = readStdout();
      expect(output).toContain("## Transcript");
      expect(output).toContain("[00:02-00:05] Hello world.");
      expect(output).toContain("[00:06-00:07] Second sentence.");
    });
  });

  describe("without timestamps (--no-timestamps)", () => {
    it("outputs plain text transcript", async () => {
      server.use(
        http.post(STT_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get("verbose")).toBeNull();
          return HttpResponse.json({ text: "Hello world. Second sentence." });
        }),
      );

      await transcribeCommand.parseAsync(
        ["--url", "https://example.com/video.mp4", "--no-timestamps"],
        { from: "user" },
      );

      const output = readStdout();
      expect(output).toContain("## Transcript");
      expect(output).toContain("Hello world. Second sentence.");
      expect(output).not.toMatch(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/);
    });
  });

  describe("with --file-id", () => {
    it("downloads via the web file API and transcribes", async () => {
      let requestedFileId: string | null = null;
      server.use(
        http.get(DOWNLOAD_URL, ({ request }) => {
          requestedFileId = new URL(request.url).searchParams.get("file_id");
          return new HttpResponse(new Uint8Array([1, 2, 3, 4]), {
            headers: {
              "content-type": "video/mp4",
              "content-length": "4",
            },
          });
        }),
        http.post(STT_URL, () => {
          return HttpResponse.json({ text: "File content." });
        }),
      );

      await transcribeCommand.parseAsync(["--file-id", "abc-123-def"], {
        from: "user",
      });

      expect(requestedFileId).toBe("abc-123-def");
      expect(readStdout()).toContain("File content.");
    });
  });

  describe("with --file", () => {
    it("does not call curl when --file is provided", async () => {
      const { execFileSync } = await import("child_process");
      server.use(
        http.post(STT_URL, () => {
          return HttpResponse.json({ text: "Local file transcript." });
        }),
      );

      await transcribeCommand.parseAsync(["--file", "/tmp/some-video.mp4"], {
        from: "user",
      });

      const execCalls = vi.mocked(execFileSync).mock.calls;
      const curlCalls = execCalls.filter((c) => {
        return c[0] === "curl";
      });
      expect(curlCalls).toHaveLength(0);
    });

    it("transcribes the local file and outputs the result", async () => {
      server.use(
        http.post(STT_URL, () => {
          return HttpResponse.json({
            text: "Local file transcript.",
            segments: [{ start: 0, end: 2, text: " Local file transcript." }],
          });
        }),
      );

      await transcribeCommand.parseAsync(["--file", "/tmp/some-video.mp4"], {
        from: "user",
      });

      const output = readStdout();
      expect(output).toContain("## Transcript");
      expect(output).toContain("Local file transcript.");
    });
  });

  describe("missing arguments", () => {
    it("exits with error when neither --url nor --file-id nor --file provided", async () => {
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
