/**
 * Integration tests for the click-driven camera command.
 *
 * Only ffmpeg and ffprobe are mocked. The command parses real sidecars, writes
 * real camera plans, and exercises Commander end to end. The mock records the
 * generated `-vf` filter so the render geometry can be asserted; ffmpeg itself
 * never runs here, so these tests cannot catch a filter that real ffmpeg
 * rejects.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraCommand } from "../camera";

vi.mock("child_process", async () => {
  const { writeFileSync } =
    await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    execFileSync: vi.fn((command: string, args: readonly string[]) => {
      if (command === "ffprobe") {
        return JSON.stringify({
          streams: [
            {
              width: 1920,
              height: 1080,
              avg_frame_rate: "30/1",
              r_frame_rate: "30/1",
            },
          ],
          format: { duration: "10.000000" },
        });
      }
      if (command === "ffmpeg") {
        const filterIndex = args.indexOf("-vf");
        const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
        const outputPath = args.at(-1);
        if (filter && outputPath) {
          writeFileSync(outputPath, filter);
        }
      }
      return Buffer.from("");
    }),
  };
});

const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => {
  return true;
});

function stdout(): string {
  return stdoutWrite.mock.calls
    .map((call) => {
      return call[0];
    })
    .join("");
}

describe("okou video camera command", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-video-camera-test-"));
    stdoutWrite.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates a camera plan and renders an automatic first cut", async () => {
    const videoPath = join(directory, "recording.mp4");
    const eventsPath = join(directory, "recording.clicks.json");
    const outputPath = join(directory, "draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        version: 1,
        recording: {
          durationMs: 10_000,
          video: { width: 1920, height: 1080, frameRate: 30 },
        },
        clicks: [
          { tMs: 2_000, normalized: { x: 0.12, y: 0.22 } },
          { tMs: 4_500, normalized: { x: 0.82, y: 0.8 } },
        ],
        pointerEvents: [
          { tMs: 1_700, kind: "move", normalized: { x: 0.1, y: 0.2 } },
          { tMs: 2_000, kind: "click", normalized: { x: 0.12, y: 0.22 } },
          { tMs: 2_300, kind: "move", normalized: { x: 0.15, y: 0.25 } },
          { tMs: 3_000, kind: "move", normalized: { x: 0.8, y: 0.8 } },
          { tMs: 4_500, kind: "click", normalized: { x: 0.82, y: 0.8 } },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as {
      outputPath: string;
      planPath: string;
      reviewPath: string;
      reviewFrames: number;
      cameraRanges: number;
    };
    expect(result).toMatchObject({ outputPath, cameraRanges: 1 });
    const plan = JSON.parse(readFileSync(result.planPath, "utf8")) as {
      algorithm: string;
      ranges: {
        startMs: number;
        endMs: number;
        scale: number;
        focuses: readonly unknown[];
      }[];
    };
    expect(plan.algorithm).toBe("screen-studio-compatible-v1");
    expect(plan.ranges).toEqual([
      expect.objectContaining({
        startMs: 1_700,
        endMs: 7_000,
        scale: 2,
        focuses: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
      }),
    ]);
    const review = JSON.parse(readFileSync(result.reviewPath, "utf8")) as {
      checkpoints: {
        timeMs: number;
        reasons: { kind: string; offsetMs?: number }[];
        sourceFramePath: string;
        outputFramePath: string;
      }[];
    };
    expect(review.checkpoints).toHaveLength(result.reviewFrames);
    expect(
      review.checkpoints.flatMap((checkpoint) => {
        return checkpoint.reasons;
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "click-before" }),
        expect.objectContaining({ kind: "click" }),
        expect.objectContaining({ kind: "click-after", offsetMs: 500 }),
        expect.objectContaining({ kind: "click-after", offsetMs: 1_500 }),
        expect.objectContaining({ kind: "pan-midpoint" }),
        expect.objectContaining({ kind: "zoom-enter" }),
        expect.objectContaining({ kind: "zoom-exit" }),
        expect.objectContaining({ kind: "maximum-camera-speed" }),
      ]),
    );
    expect(review.checkpoints[0]).toEqual(
      expect.objectContaining({
        sourceFramePath: expect.stringMatching(/-source\.jpg$/u),
        outputFramePath: expect.stringMatching(/-output\.jpg$/u),
      }),
    );

    // libavfilter cannot resize a filter output link at runtime, so the render
    // must keep a fixed output size and move a sampling window instead of
    // animating `crop`.
    const renderedFilter = readFileSync(outputPath, "utf8");
    expect(renderedFilter).toContain("zoompan=");
    expect(renderedFilter).toContain(":d=1:s=1920x1080");
    expect(renderedFilter).not.toContain("sendcmd");
    expect(renderedFilter).not.toContain("crop@camera");
    expect(renderedFilter).toContain("2.000000");
    const ffmpegCall = vi.mocked(execFileSync).mock.calls.find((call) => {
      return call[0] === "ffmpeg";
    });
    expect(ffmpegCall?.[1]).toEqual(
      expect.arrayContaining([
        "-vf",
        expect.stringContaining("zoompan="),
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
      ]),
    );
  });

  it("uses the existing VM0 demo capture event format", async () => {
    const videoPath = join(directory, "browser-recording.webm");
    const eventsPath = join(directory, "browser-recording.events.json");
    const outputPath = join(directory, "browser-draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        schemaVersion: 1,
        generator: { name: "VM0 Demo Capture", version: "0.3.0" },
        session: {
          durationMs: 10_000,
          recording: {
            durationMs: 10_000,
            goOffsetMs: 500,
            width: 1920,
            height: 1080,
            frameRate: 30,
          },
        },
        events: [
          { type: "session-start", t: 0 },
          { type: "pointermove", t: 1_700, nx: 0.1, ny: 0.2 },
          { type: "pointerdown", t: 2_000, nx: 0.12, ny: 0.22 },
          { type: "click", t: 2_100, nx: 0, ny: 0 },
          { type: "pointermove", t: 3_000, nx: 0.8, ny: 0.8 },
          { type: "pointerdown", t: 5_000, nx: 0.82, ny: 0.8 },
          { type: "session-stop", t: 10_500 },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as {
      planPath: string;
      cameraRanges: number;
    };
    expect(result.cameraRanges).toBe(1);
    const plan = JSON.parse(readFileSync(result.planPath, "utf8")) as {
      ranges: {
        startMs: number;
        endMs: number;
        focuses: { x: number; y: number }[];
      }[];
    };
    expect(plan.ranges).toEqual([
      expect.objectContaining({
        startMs: 1_200,
        endMs: 7_000,
        focuses: expect.arrayContaining([
          expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        ]),
      }),
    ]);
  });

  it("rejects a sidecar whose timestamps are not recording-relative", async () => {
    const videoPath = join(directory, "recording.mp4");
    const eventsPath = join(directory, "recording.clicks.json");
    const outputPath = join(directory, "draft.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      eventsPath,
      JSON.stringify({
        version: 1,
        recording: {
          durationMs: 10_000,
          video: { width: 1920, height: 1080, frameRate: 30 },
        },
        // A desktop recorder emitted these from a monotonic system clock rather
        // than from the recording start, so none of them land in the video.
        clicks: [
          { tMs: 8_191_037_307, normalized: { x: 0.45, y: 0.48 } },
          { tMs: 8_191_786_602, normalized: { x: 0.52, y: 0.96 } },
        ],
      }),
    );

    await expect(
      cameraCommand.parseAsync(
        ["--file", videoPath, "--events", eventsPath, "--output", outputPath],
        { from: "user" },
      ),
    ).rejects.toThrow(/not relative to the recording start/u);
  });

  it("renders an AI-edited camera plan without regenerating it", async () => {
    const videoPath = join(directory, "recording.mp4");
    const planPath = join(directory, "edited.camera-plan.json");
    const outputPath = join(directory, "final.mp4");
    writeFileSync(videoPath, Buffer.from("source-video"));
    writeFileSync(
      planPath,
      JSON.stringify({
        version: 1,
        algorithm: "screen-studio-compatible-v1",
        source: {
          durationMs: 10_000,
          width: 1920,
          height: 1080,
          frameRate: 30,
        },
        ranges: [
          {
            id: "camera-001",
            startMs: 1_000,
            endMs: 4_000,
            scale: 1.5,
            focuses: [
              {
                id: "camera-001-focus-001",
                startMs: 1_000,
                x: 0.5,
                y: 0.5,
              },
            ],
          },
        ],
      }),
    );

    await cameraCommand.parseAsync(
      ["--file", videoPath, "--plan", planPath, "--output", outputPath],
      { from: "user" },
    );

    const result = JSON.parse(stdout()) as { planPath: string };
    expect(result.planPath).toBe(planPath);
    const renderedFilter = readFileSync(outputPath, "utf8");
    expect(renderedFilter).toContain("zoompan=");
    expect(renderedFilter).toContain("1.500000");
    const unchangedPlan = JSON.parse(readFileSync(planPath, "utf8")) as {
      ranges: { scale: number }[];
    };
    expect(unchangedPlan.ranges[0]?.scale).toBe(1.5);
  });
});
