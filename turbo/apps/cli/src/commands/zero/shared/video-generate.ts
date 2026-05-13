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
      "Model: veo3.1-fast, veo3.1, kling-o3-standard, kling-v3-4k, seedance2.0, or seedance2.0-fast",
      "veo3.1-fast",
    )
    .option(
      "--aspect-ratio <ratio>",
      "Aspect ratio: 16:9 or 9:16; Seedance also supports 21:9, 4:3, 1:1, 3:4",
      "16:9",
    )
    .option(
      "--duration <duration>",
      "Duration: 3s-15s; Veo supports 4s/6s/8s",
      "8s",
    )
    .option("--resolution <resolution>", "Resolution: 720p, 1080p, or 4k")
    .option("--no-audio", "Generate a silent video")
    .option("--negative-prompt <text>", "Negative prompt")
    .option("--seed <integer>", "Deterministic seed", parseSeed)
    .option("--no-auto-fix", "Disable fal prompt auto-fix")
    .option("--safety-tolerance <level>", "Safety tolerance: 1-6", "4")
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
  - Uses fal video models with configured usage pricing`,
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
