import { readFileSync } from "fs";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebPresentation } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface PresentationOptions {
  prompt?: string;
  style: string;
  slides: number;
  images: number;
  theme?: string;
  audience?: string;
  title?: string;
  json?: boolean;
}

interface PresentationGenerateCommandConfig {
  name: string;
  usageCommand: string;
  examples: string;
}

function parseSlideCount(value: string): number {
  const slideCount = Number(value);
  if (!Number.isInteger(slideCount)) {
    throw new InvalidArgumentError("slides must be an integer");
  }
  return slideCount;
}

function parseImageCount(value: string): number {
  const imageCount = Number(value);
  if (!Number.isInteger(imageCount)) {
    throw new InvalidArgumentError("images must be an integer");
  }
  return imageCount;
}

function readPrompt(
  options: PresentationOptions,
  usageCommand: string,
): string {
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
    cause: new Error(
      `Usage: ${usageCommand} --prompt "A product roadmap deck"`,
    ),
  });
}

export function createPresentationGenerateCommand(
  config: PresentationGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed HTML presentation from a prompt")
    .option(
      "--prompt <text>",
      "Presentation prompt; can also be piped via stdin",
    )
    .option("--style <style>", "Style: editorial or swiss", "editorial")
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .option(
      "--images <count>",
      "Generated image count: 0-8",
      parseImageCount,
      2,
    )
    .option(
      "--theme <theme>",
      "Theme: editorial supports ink, coral, forest; swiss supports ikb, lemon, lime, mono",
    )
    .option("--audience <text>", "Audience context")
    .option("--title <text>", "Requested deck title")
    .option("--json", "Print metadata as JSON")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ HTML presentation URL and metadata

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Charges org credits after successful presentation generation
  - Uses OpenAI gpt-5.5 through the Responses API`,
    )
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const prompt = readPrompt(options, config.usageCommand);
        const result = await generateWebPresentation({
          prompt,
          style: options.style,
          slideCount: options.slides,
          imageCount: options.images,
          theme: options.theme,
          audience: options.audience,
          title: options.title,
        });

        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green(`✓ Presentation generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Title: ${result.title}`));
        console.log(chalk.dim(`  Slides: ${result.slideCount}`));
        console.log(chalk.dim(`  Images: ${result.imageCount}`));
        console.log(chalk.dim(`  Style: ${result.style}`));
        console.log(chalk.dim(`  Theme: ${result.theme}`));
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Text credits: ${result.textCreditsCharged}`));
        console.log(
          chalk.dim(`  Image credits: ${result.imageCreditsCharged}`),
        );
        console.log(chalk.dim(`  Model: ${result.model}`));
      }),
    );
}
