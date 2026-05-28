import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

const PRESENTATION_MAX_IMAGES = 8;

interface PresentationOptions {
  prompt?: string;
  provider?: string;
  style: string;
  slides: number;
  images: number;
  imageModel?: string;
  theme?: string;
  audience?: string;
  title?: string;
  all?: boolean;
  json?: boolean;
}

interface PresentationGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
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
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run vm0's pipeline, or a connector name to get its skill-invocation guidance",
    )
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
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
  Prints a source-selection packet for the current agent.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML presentation artifact and hosts it with zero host`,
    )
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          provider: options.provider,
          prompt: options.prompt,
          all: options.all,
          json: options.json,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;

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
      }),
    );
}
