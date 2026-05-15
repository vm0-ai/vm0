import { readFileSync } from "fs";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebImage } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface ImageOptions {
  prompt?: string;
  model: string;
  size: string;
  quality: string;
  background: string;
  format: string;
  compression?: string;
  moderation: string;
  seed?: number;
  safetyTolerance: string;
  enhancePrompt?: boolean;
  json?: boolean;
}

interface ImageGenerateCommandConfig {
  name: string;
  usageCommand: string;
  examples: string;
}

function readPrompt(options: ImageOptions, usageCommand: string): string {
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
    cause: new Error(`Usage: ${usageCommand} --prompt "A watercolor fox"`),
  });
}

function parseCompression(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const compression = Number(value);
  if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
    throw new Error("--compression must be an integer from 0 to 100");
  }

  return compression;
}

function parseSeed(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new InvalidArgumentError("seed must be a non-negative safe integer");
  }
  return seed;
}

export function createImageGenerateCommand(
  config: ImageGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed image file from a prompt")
    .option("--prompt <text>", "Image prompt; can also be piped via stdin")
    .option(
      "--model <model>",
      "Model: gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, or seedream4",
      "gpt-image-2",
    )
    .option(
      "--size <size>",
      "Image size: auto or WIDTHxHEIGHT; support varies by model",
      "1024x1024",
    )
    .option(
      "--quality <quality>",
      "Image quality: low, medium, high, or auto",
      "medium",
    )
    .option(
      "--background <background>",
      "Background: auto, opaque, or transparent when supported",
      "auto",
    )
    .option("--format <format>", "Output format: png, webp, or jpeg", "png")
    .option("--compression <0-100>", "Output compression for jpeg/webp only")
    .option(
      "--moderation <moderation>",
      "Moderation strictness: auto or low",
      "auto",
    )
    .option("--seed <integer>", "Deterministic seed for fal models", parseSeed)
    .option("--safety-tolerance <level>", "fal safety tolerance: 1-6", "4")
    .option("--enhance-prompt", "Enable fal prompt enhancement when supported")
    .option("--json", "Print metadata as JSON")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ image file URL and metadata

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Charges org credits after successful image generation
  - Uses OpenAI for GPT Image models and fal.ai for non-OpenAI models

Models:
  - OpenAI: gpt-image-2 (default), gpt-image-1.5, gpt-image-1,
    gpt-image-1-mini. OpenAI generations bill returned text/image/output
    token usage.
  - fal.ai: flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, seedream4.
    fal generations bill by output image or rounded-up output megapixel,
    depending on the model.

Options:
  - Prompt: required, up to 32,000 characters; stdin is supported.
  - Size: gpt-image-2 accepts auto or WIDTHxHEIGHT. Popular sizes include
    1024x1024,
    1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160,
    and 2160x3840. Custom sizes must have edges <= 3840px, both
    edges divisible by 16, long:short ratio <= 3:1, and total pixels
    between 655,360 and 8,294,400. gpt-image-1.5, gpt-image-1, and
    gpt-image-1-mini use auto, 1024x1024, 1536x1024, or 1024x1536.
  - Quality: low, medium, high, or auto. Low is fastest for drafts.
  - Background: auto, opaque, or transparent. gpt-image-2 and fal models do
    not support transparent backgrounds.
  - Format: png, jpeg, or webp for OpenAI; png or jpeg for fal. Use
    --compression 0-100 only with OpenAI jpeg or webp outputs.
  - Moderation: auto or low for OpenAI models.
  - fal-only controls: --seed, --safety-tolerance for Flux, and
    --enhance-prompt for flux-pro-1.1.
  - This command generates one text-to-image result. GPT Image also
    supports image edits, reference images, masks, partial-image streaming,
    and multiple images per request, but those are not exposed by this
    built-in Zero command yet.`,
    )
    .action(
      withErrorHandler(async (options: ImageOptions) => {
        const prompt = readPrompt(options, config.usageCommand);
        const compression = parseCompression(options.compression);
        const result = await generateWebImage({
          prompt,
          model: options.model,
          size: options.size,
          quality: options.quality,
          background: options.background,
          outputFormat: options.format,
          outputCompression: compression,
          moderation: options.moderation,
          seed: options.seed,
          safetyTolerance: options.safetyTolerance,
          enhancePrompt: options.enhancePrompt,
        });

        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green(`✓ Image generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Size: ${result.imageSize}`));
        console.log(chalk.dim(`  Quality: ${result.quality}`));
        console.log(chalk.dim(`  Format: ${result.outputFormat}`));
        if (result.outputCompression !== undefined) {
          console.log(chalk.dim(`  Compression: ${result.outputCompression}`));
        }
        if (result.moderation) {
          console.log(chalk.dim(`  Moderation: ${result.moderation}`));
        }
        if (result.safetyTolerance) {
          console.log(
            chalk.dim(`  Safety tolerance: ${result.safetyTolerance}`),
          );
        }
        if (result.seed !== undefined) {
          console.log(chalk.dim(`  Seed: ${result.seed}`));
        }
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
        console.log(chalk.dim(`  Provider: ${result.provider}`));
      }),
    );
}
