/**
 * Tests for zero video frames command.
 *
 * Uses vi.mock for child_process (curl/ffmpeg) and fs so the test does not
 * require real binaries or touch the filesystem in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { framesCommand } from "../frames";

vi.mock("child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

vi.mock("fs", () => {
  return {
    mkdirSync: vi.fn(),
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

function readStdout(): string {
  return mockStdoutWrite.mock.calls
    .map((c) => {
      return c[0];
    })
    .join("");
}

describe("zero video frames command", () => {
  beforeEach(() => {
    mockStdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("extracts one frame per timestamp and prints JSON paths", async () => {
    await framesCommand.parseAsync(
      ["--url", "https://example.com/video.mp4", "--at", "00:21,01:40"],
      { from: "user" },
    );

    const result = JSON.parse(readStdout()) as {
      frames: { at: string; path: string }[];
    };
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]?.at).toBe("00:21");
    expect(result.frames[1]?.at).toBe("01:40");
    expect(result.frames[0]?.path).toContain("frame-001.jpg");
    expect(result.frames[1]?.path).toContain("frame-002.jpg");

    const ffmpegCalls = vi.mocked(execFileSync).mock.calls.filter((c) => {
      return c[0] === "ffmpeg";
    });
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]?.[1]).toEqual(
      expect.arrayContaining(["-ss", "00:21", "-frames:v", "1"]),
    );
    expect(ffmpegCalls[1]?.[1]).toEqual(
      expect.arrayContaining(["-ss", "01:40"]),
    );
  });

  it("downloads via downloadWebFile when --file-id is given", async () => {
    const { downloadWebFile } = await import("../../../../lib/api/domains/web");

    await framesCommand.parseAsync(["--file-id", "abc-123", "--at", "5"], {
      from: "user",
    });

    expect(downloadWebFile).toHaveBeenCalledWith(
      "abc-123",
      expect.stringContaining("zero-video-"),
    );
    const result = JSON.parse(readStdout()) as {
      frames: { at: string }[];
    };
    expect(result.frames[0]?.at).toBe("5");
  });

  it("exits with error when neither --url nor --file-id provided", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      framesCommand.parseAsync(["--at", "5"], { from: "user" }),
    ).rejects.toThrow("process.exit called");

    mockExit.mockRestore();
  });
});
