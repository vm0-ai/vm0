import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { generateWebImage } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface ImageOptions {
  prompt?: string;
  size: string;
  quality: string;
  background: string;
  format: string;
  compression?: string;
  moderation: string;
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

export function createImageGenerateCommand(
  config: ImageGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed image file from a prompt")
    .option("--prompt <text>", "Image prompt; can also be piped via stdin")
    .option(
      "--size <size>",
      "Image size: auto or any valid WIDTHxHEIGHT for GPT Image 2",
      "1024x1024",
    )
    .option(
      "--quality <quality>",
      "Image quality: low, medium, high, or auto",
      "medium",
    )
    .option("--background <background>", "Background: auto or opaque", "auto")
    .option("--format <format>", "Output format: png, webp, or jpeg", "png")
    .option("--compression <0-100>", "Output compression for jpeg/webp only")
    .option(
      "--moderation <moderation>",
      "Moderation strictness: auto or low",
      "auto",
    )
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
  - Uses OpenAI gpt-image-2 and bills returned usage tokens

GPT Image 2 options:
  - Prompt: required, up to 32,000 characters; stdin is supported.
  - Size: use auto or WIDTHxHEIGHT. Popular sizes include 1024x1024,
    1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160,
    and 2160x3840. Custom sizes must have edges <= 3840px, both
    edges divisible by 16, long:short ratio <= 3:1, and total pixels
    between 655,360 and 8,294,400. Outputs larger than 2560x1440
    total pixels are experimental.
  - Quality: low, medium, high, or auto. Low is fastest for drafts.
  - Background: auto or opaque. GPT Image 2 does not support transparent
    backgrounds.
  - Format: png, jpeg, or webp. Use --compression 0-100 only with jpeg
    or webp; jpeg is usually lower latency than png.
  - Moderation: auto or low.
  - This command generates one text-to-image result. GPT Image 2 also
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
          size: options.size,
          quality: options.quality,
          background: options.background,
          outputFormat: options.format,
          outputCompression: compression,
          moderation: options.moderation,
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
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
      }),
    );
}
