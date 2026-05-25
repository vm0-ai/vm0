import { readFileSync } from "fs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebPresentation } from "../../../lib/api";
import { zeroTokenAllowsFeatureSwitch } from "../../../lib/api/zero-token";
import { withErrorHandler } from "../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";

const PRESENTATION_MAX_IMAGES = 8;

interface PresentationOptions {
  prompt?: string;
  style: string;
  slides: number;
  images: number;
  imageModel?: string;
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
  if (
    !Number.isSafeInteger(imageCount) ||
    imageCount < 0 ||
    imageCount > PRESENTATION_MAX_IMAGES
  ) {
    throw new InvalidArgumentError(
      `images must be between 0 and ${PRESENTATION_MAX_IMAGES}`,
    );
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
    .description("Generate an HTML presentation from a prompt")
    .option(
      "--prompt <text>",
      "Presentation prompt; can also be piped via stdin",
    )
    .option("--style <style>", "Style: editorial or swiss", "editorial")
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .option(
      "--images <count>",
      `Generated image count: 0-${PRESENTATION_MAX_IMAGES}`,
      parseImageCount,
      2,
    )
    .option(
      "--image-model <model>",
      "Image model for generated visuals (default: gpt-image-1): gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, or seedream4",
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
  Prints the generated /f/ HTML presentation URL and metadata. With openDesignGenerate enabled, prints an OpenDesign-style authoring packet for the current agent instead.

Notes:
  - Authenticates via ZERO_TOKEN
  - Default path charges org credits after successful presentation generation
  - OpenDesign path is gated by the openDesignGenerate feature switch`,
    )
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const prompt = readPrompt(options, config.usageCommand);
        if (zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.OpenDesignGenerate)) {
          const packet = createHtmlArtifactAuthoringPacket({
            kind: "presentation",
            prompt,
            slugSource: options.title,
            details: [
              `Style: ${options.style}`,
              `Slide count: ${options.slides}`,
              `Suggested generated visual count: ${options.images}`,
              `Image model preference if visuals are generated separately: ${
                options.imageModel ?? "default"
              }`,
              `Theme: ${options.theme ?? "agent decides from style"}`,
              `Audience: ${options.audience ?? "not specified"}`,
              `Requested deck title: ${options.title ?? "not specified"}`,
            ],
            artifactRules: [
              "Think like a presentation designer, not a web page designer.",
              "Use a fixed 1920x1080 slide canvas and scale it uniformly for smaller viewports.",
              "Use one section per slide and keep repeated elements in consistent positions.",
              "Make keyboard navigation work with ArrowLeft, ArrowRight, Home, and End.",
              "Keep slide text readable from across a room; avoid memo-like walls of text.",
            ],
          });

          if (options.json) {
            console.log(JSON.stringify(packet));
            return;
          }
          console.log(packet.instructions);
          return;
        }

        const result = await generateWebPresentation({
          prompt,
          style: options.style,
          slideCount: options.slides,
          imageCount: options.images,
          imageModel: options.imageModel,
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
        console.log(chalk.dim(`  Image model: ${result.imageModel}`));
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
