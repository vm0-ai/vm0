import { readFileSync } from "fs";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebVideo } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface VideoOptions {
  prompt?: string;
  model: string;
  aspectRatio: string;
  duration: string;
  resolution?: string;
  audio?: boolean;
  negativePrompt?: string;
  seed?: number;
  autoFix?: boolean;
  safetyTolerance: string;
  imageUrl?: string[];
  videoUrl?: string[];
  audioUrl?: string[];
  firstFrameImageUrl?: string;
  lastFrameImageUrl?: string;
  json?: boolean;
}

interface VideoGenerateCommandConfig {
  name: string;
  usageCommand: string;
  examples: string;
}

function parseSeed(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new InvalidArgumentError("seed must be a non-negative safe integer");
  }
  return seed;
}

function collectUrl(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function readPrompt(options: VideoOptions, usageCommand: string): string {
  if (options.prompt?.trim()) {
    return options.prompt.trim();
  }

  if (process.stdin.isTTY === false) {
    const prompt = readFileSync("/dev/stdin", "utf8").trim();
    if (prompt.length > 0) {
      return prompt;
    }
  }

  throw new Error("--prompt is required", {
    cause: new Error(`Usage: ${usageCommand} --prompt "A cinematic city shot"`),
  });
}

export function createVideoGenerateCommand(
  config: VideoGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed video file from a prompt")
    .option("--prompt <text>", "Video prompt; can also be piped via stdin")
    .option(
      "--model <model>",
      "Model: dreamina-seedance-2.0-fast, dreamina-seedance-2.0, seedance-1.5-pro, veo3.1-fast, or kling-v3-4k",
      "dreamina-seedance-2.0-fast",
    )
    .option(
      "--aspect-ratio <ratio>",
      "Aspect ratio: 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16",
      "16:9",
    )
    .option(
      "--duration <duration>",
      "Duration: 2s-15s depending on model",
      "8s",
    )
    .option("--resolution <resolution>", "Resolution: 480p, 720p, or 1080p")
    .option("--no-audio", "Generate a silent video")
    .option("--negative-prompt <text>", "Negative prompt")
    .option("--seed <integer>", "Deterministic seed", parseSeed)
    .option("--no-auto-fix", "Disable prompt auto-fix")
    .option("--safety-tolerance <level>", "Safety tolerance", "4")
    .option(
      "--image-url <url>",
      "Reference image URL; repeat for multiple Dreamina Seedance 2.0 references",
      collectUrl,
      [],
    )
    .option(
      "--video-url <url>",
      "Reference video URL; repeat up to 3 times for Dreamina Seedance 2.0",
      collectUrl,
      [],
    )
    .option(
      "--audio-url <url>",
      "Reference audio URL for Dreamina Seedance 2.0",
      collectUrl,
      [],
    )
    .option("--first-frame-image-url <url>", "First frame image URL")
    .option("--last-frame-image-url <url>", "Last frame image URL")
    .option("--json", "Print metadata as JSON")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ video file URL and metadata

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Charges org credits after successful video generation
  - Uses BytePlus ModelArk and fal.ai video models with configured usage pricing

Models:
  - Dreamina Seedance 2.0: dreamina-seedance-2.0,
    dreamina-seedance-2.0-fast (default). Supports 4s-15s,
    480p/720p, seed, optional audio, image references, and first/last
    frames. The non-fast model also supports 1080p and video/audio references.
  - Seedance 1.5 Pro: seedance-1.5-pro. Supports 4s-12s,
    480p/720p/1080p, seed, optional audio, image references, and
    first/last frames.
  - fal.ai: veo3.1-fast and kling-v3-4k. veo3.1-fast supports
    4s/6s/8s, 720p/1080p/4k, negative prompts, seed, auto-fix,
    safety tolerance, and optional audio. kling-v3-4k supports 3s-15s,
    4k output, negative prompts, and optional audio.`,
    )
    .action(
      withErrorHandler(async (options: VideoOptions) => {
        const prompt = readPrompt(options, config.usageCommand);
        const result = await generateWebVideo({
          prompt,
          model: options.model,
          aspectRatio: options.aspectRatio,
          duration: options.duration,
          resolution: options.resolution,
          generateAudio: options.audio !== false,
          negativePrompt: options.negativePrompt,
          seed: options.seed,
          autoFix: options.autoFix !== false,
          safetyTolerance: options.safetyTolerance,
          imageUrls: options.imageUrl,
          videoUrls: options.videoUrl,
          audioUrls: options.audioUrl,
          firstFrameImageUrl: options.firstFrameImageUrl,
          lastFrameImageUrl: options.lastFrameImageUrl,
        });

        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green(`✓ Video generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Duration: ${result.duration}`));
        console.log(chalk.dim(`  Resolution: ${result.resolution}`));
        console.log(chalk.dim(`  Aspect ratio: ${result.aspectRatio}`));
        console.log(
          chalk.dim(`  Audio: ${result.generateAudio ? "on" : "off"}`),
        );
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
      }),
    );
}
