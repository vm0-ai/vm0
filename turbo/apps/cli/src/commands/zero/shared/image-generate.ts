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

export function createImageGenerateCommand(
  config: ImageGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed image file from a prompt")
    .option("--prompt <text>", "Image prompt; can also be piped via stdin")
    .option(
      "--size <size>",
      "Image size: 1024x1024, 1024x1536, or 1536x1024",
      "1024x1024",
    )
    .option(
      "--quality <quality>",
      "Image quality: low, medium, high, or auto",
      "medium",
    )
    .option(
      "--background <background>",
      "Background: auto, opaque, or transparent",
      "auto",
    )
    .option("--format <format>", "Output format: png, webp, or jpeg", "png")
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
  - Uses OpenAI gpt-image-2 and bills returned usage tokens`,
    )
    .action(
      withErrorHandler(async (options: ImageOptions) => {
        const prompt = readPrompt(options, config.usageCommand);
        const result = await generateWebImage({
          prompt,
          size: options.size,
          quality: options.quality,
          background: options.background,
          outputFormat: options.format,
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
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
      }),
    );
}
