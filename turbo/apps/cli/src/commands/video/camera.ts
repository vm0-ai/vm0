import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import { z } from "zod";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  cameraPlanSchema,
  createCameraPlan,
  createFfmpegCameraCommands,
  inputTrackClickTimes,
  inputTrackSchema,
  inputTrackVideoSource,
} from "./camera-plan";
import type { CameraPlan, VideoSource } from "./camera-plan";
import {
  createCameraReviewCheckpoints,
  type CameraReviewCheckpoint,
} from "./camera-review";

const ffprobeSchema = z.object({
  streams: z
    .array(
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .min(1),
  format: z.object({ duration: z.string().optional() }),
});

interface CameraCommandOptions {
  readonly file: string;
  readonly events?: string;
  readonly plan?: string;
  readonly output: string;
  readonly planOutput?: string;
  readonly force?: boolean;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * `ffprobe` genuinely omits `format.duration` for some containers, so the
 * duration falls back to the value the recording sidecar or plan declares.
 * Width and height always come from the probe, because a mismatch there means
 * the wrong file.
 *
 * The frame rate is never probed. A screen capture only stores a frame when
 * the picture changes, so for a recording with long still stretches `ffprobe`
 * reports an average of well under one frame per second. That number looks
 * valid, and rendering at it turned the cut into a slideshow and left the
 * camera motion with almost no frames to move on. The recording declares the
 * rate it was captured at, and that is the rate the cut plays back at.
 */
function probeVideo(path: string, declared: VideoSource): VideoSource {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const result = ffprobeSchema.parse(JSON.parse(raw) as unknown);
  const video = result.streams[0];
  if (!video) {
    throw new Error("Source file has no video stream");
  }
  const durationSeconds = Number(result.format.duration);
  return {
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.round(durationSeconds * 1_000)
        : declared.durationMs,
    width: video.width,
    height: video.height,
    frameRate: declared.frameRate,
  };
}

function defaultPlanPath(outputPath: string): string {
  const output = parse(outputPath);
  return join(output.dir, `${output.name}.camera-plan.json`);
}

function defaultReviewPath(outputPath: string): string {
  const output = parse(outputPath);
  return join(output.dir, `${output.name}.camera-review.json`);
}

function reviewFramesDirectory(reviewPath: string): string {
  const review = parse(reviewPath);
  return join(review.dir, review.name);
}

function assertPlanMatchesVideo(plan: CameraPlan, source: VideoSource): void {
  if (
    plan.source.width !== source.width ||
    plan.source.height !== source.height
  ) {
    throw new Error("Camera plan does not match the source video dimensions");
  }
  if (Math.abs(plan.source.durationMs - source.durationMs) > 1_000) {
    throw new Error("Camera plan does not match the source video duration");
  }
}

function assertWritableOutput(path: string, force: boolean): void {
  if (!force && existsSync(path)) {
    throw new Error(
      `Output already exists: ${path}. Pass --force to replace it`,
    );
  }
}

function renderVideo(
  inputPath: string,
  outputPath: string,
  plan: CameraPlan,
  force: boolean,
): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "okou-camera-"));
  try {
    const commandsPath = join(temporaryDirectory, "camera.commands");
    writeFileSync(commandsPath, createFfmpegCameraCommands(plan));
    // The `null` stage between the crop and the scaler is load-bearing. When
    // a command changes the crop's w or h, `crop` rewrites the size of its
    // own output link, and `scale` decides whether to reconfigure by comparing
    // each frame with the link it reads from. Wired directly, that link is the
    // one `crop` just rewrote, so `scale` never sees a change; and because the
    // first frames are full size it never built a scaler at all, so it hands
    // the shrunken frames straight to the encoder, which was opened for the
    // full size, reads past the end of their buffer and dies with SIGSEGV.
    // `null` keeps its own link size, so `scale` sees every size change and
    // rescales the frame. Reproduced on ffmpeg 6.1 and 7.0 (#31169).
    const filter = [
      `fps=${plan.source.frameRate.toString()}`,
      `sendcmd=f='${commandsPath}'`,
      `crop@camera=w=${plan.source.width.toString()}:h=${plan.source.height.toString()}:x=0:y=0:exact=1`,
      "null",
      `scale=${plan.source.width.toString()}:${plan.source.height.toString()}:flags=lanczos`,
      "setsar=1",
    ].join(",");
    execFileSync(
      "ffmpeg",
      [
        force ? "-y" : "-n",
        "-v",
        "error",
        "-i",
        inputPath,
        "-vf",
        filter,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function extractReviewFrame(
  videoPath: string,
  timeMs: number,
  outputPath: string,
): void {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      (timeMs / 1_000).toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function writeCameraReview(args: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly planPath: string;
  readonly reviewPath: string;
  readonly checkpoints: readonly CameraReviewCheckpoint[];
}): void {
  const framesDirectory = reviewFramesDirectory(args.reviewPath);
  mkdirSync(framesDirectory, { recursive: true });
  const checkpoints = args.checkpoints.map((checkpoint) => {
    const sourceFramePath = join(
      framesDirectory,
      `${checkpoint.id}-source.jpg`,
    );
    const outputFramePath = join(
      framesDirectory,
      `${checkpoint.id}-output.jpg`,
    );
    extractReviewFrame(args.sourcePath, checkpoint.timeMs, sourceFramePath);
    extractReviewFrame(args.outputPath, checkpoint.timeMs, outputFramePath);
    return { ...checkpoint, sourceFramePath, outputFramePath };
  });
  writeFileSync(
    args.reviewPath,
    `${JSON.stringify(
      {
        version: 1,
        sourcePath: args.sourcePath,
        outputPath: args.outputPath,
        planPath: args.planPath,
        checkpoints,
      },
      null,
      2,
    )}\n`,
  );
}

export const cameraCommand = new Command()
  .name("camera")
  .description(
    "Apply automatic click-driven camera moves to a screen recording",
  )
  .requiredOption("--file <path>", "Local source video")
  .option("--events <path>", "VM0 recording event sidecar to generate a plan")
  .option("--plan <path>", "Existing camera plan to render")
  .requiredOption("--output <path>", "Rendered MP4 path")
  .option(
    "--plan-output <path>",
    "Generated plan path (defaults beside the rendered video)",
  )
  .option("--force", "Replace existing output files")
  .addHelpText(
    "after",
    `
Examples:
  Automatic first cut:
    okou video camera --file recording.mp4 --events recording.clicks.json --output draft.mp4

  Render an AI-edited plan:
    okou video camera --file recording.mp4 --plan draft.camera-plan.json --output final.mp4 --force

Output:
  Writes the rendered MP4, editable plan, and a review manifest with paired source/output checkpoint frames.
  Prints their paths and render metadata as JSON.

Notes:
  - Exactly one of --events or --plan is required
  - The generated camera plan is editable JSON; change ranges, scale, or focus points and render again
  - Requires ffmpeg and ffprobe on PATH`,
  )
  .action(
    withErrorHandler(async (options: CameraCommandOptions) => {
      if (Boolean(options.events) === Boolean(options.plan)) {
        throw new Error(
          "Provide exactly one of --events <path> or --plan <path>",
        );
      }
      if (options.plan && options.planOutput) {
        throw new Error("--plan-output can only be used with --events");
      }

      const inputPath = resolve(options.file);
      const outputPath = resolve(options.output);
      const force = options.force === true;
      if (!existsSync(inputPath)) {
        throw new Error(`Source video does not exist: ${inputPath}`);
      }
      if (inputPath === outputPath) {
        throw new Error(
          "Source video and output video must use different paths",
        );
      }
      assertWritableOutput(outputPath, force);
      mkdirSync(dirname(outputPath), { recursive: true });

      let plan: CameraPlan;
      let planPath: string;
      let clickTimes: readonly number[] = [];
      let eventsPath: string | null = null;
      let generatedPlan = false;
      if (options.events) {
        eventsPath = resolve(options.events);
        if (eventsPath === outputPath) {
          throw new Error(
            "Rendered video must not overwrite the event sidecar",
          );
        }
        const track = inputTrackSchema.parse(parseJsonFile(eventsPath));
        clickTimes = inputTrackClickTimes(track);
        const source = probeVideo(inputPath, inputTrackVideoSource(track));
        plan = createCameraPlan(track, source);
        planPath = resolve(options.planOutput ?? defaultPlanPath(outputPath));
        if (
          planPath === eventsPath ||
          planPath === inputPath ||
          planPath === outputPath
        ) {
          throw new Error(
            "Generated plan must use a path distinct from all input and output files",
          );
        }
        assertWritableOutput(planPath, force);
        generatedPlan = true;
      } else {
        planPath = resolve(options.plan as string);
        if (planPath === outputPath) {
          throw new Error("Rendered video must not overwrite the camera plan");
        }
        plan = cameraPlanSchema.parse(parseJsonFile(planPath));
        const source = probeVideo(inputPath, plan.source);
        assertPlanMatchesVideo(plan, source);
      }

      const reviewPath = defaultReviewPath(outputPath);
      if (
        reviewPath === inputPath ||
        reviewPath === outputPath ||
        reviewPath === planPath ||
        reviewPath === eventsPath
      ) {
        throw new Error(
          "Camera review must use a path distinct from all inputs and outputs",
        );
      }
      assertWritableOutput(reviewPath, force);
      const checkpoints = createCameraReviewCheckpoints(plan, clickTimes);
      const reviewDirectory = reviewFramesDirectory(reviewPath);
      for (const checkpoint of checkpoints) {
        assertWritableOutput(
          join(reviewDirectory, `${checkpoint.id}-source.jpg`),
          force,
        );
        assertWritableOutput(
          join(reviewDirectory, `${checkpoint.id}-output.jpg`),
          force,
        );
      }
      if (generatedPlan) {
        mkdirSync(dirname(planPath), { recursive: true });
        writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      }

      const renderStartedAt = performance.now();
      renderVideo(inputPath, outputPath, plan, force);
      writeCameraReview({
        sourcePath: inputPath,
        outputPath,
        planPath,
        reviewPath,
        checkpoints,
      });
      const renderMs = Math.round(performance.now() - renderStartedAt);
      process.stdout.write(
        `${JSON.stringify({
          outputPath,
          planPath,
          reviewPath,
          reviewFrames: checkpoints.length,
          durationMs: plan.source.durationMs,
          width: plan.source.width,
          height: plan.source.height,
          frameRate: plan.source.frameRate,
          cameraRanges: plan.ranges.length,
          sizeBytes: statSync(outputPath).size,
          renderMs,
        })}\n`,
      );
    }),
  );
