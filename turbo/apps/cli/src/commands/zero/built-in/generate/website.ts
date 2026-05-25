import { readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "../../shared/html-artifact-authoring";

const WEBSITE_TEMPLATES = ["auto", "launch", "profile"] as const;
const WEBSITE_MAX_IMAGES = 3;

interface WebsiteOptions {
  readonly prompt?: string;
  readonly template: string;
  readonly images: number;
  readonly imageModel?: string;
  readonly site?: string;
  readonly title?: string;
  readonly audience?: string;
  readonly json?: boolean;
}

function parseTemplate(value: string): string {
  if (
    WEBSITE_TEMPLATES.some((template) => {
      return template === value;
    })
  ) {
    return value;
  }
  throw new InvalidArgumentError("template must be auto, launch, or profile");
}

function parseImageCount(value: string): number {
  const imageCount = Number(value);
  if (!Number.isInteger(imageCount)) {
    throw new InvalidArgumentError("images must be an integer");
  }
  if (
    !Number.isSafeInteger(imageCount) ||
    imageCount < 0 ||
    imageCount > WEBSITE_MAX_IMAGES
  ) {
    throw new InvalidArgumentError(
      `images must be between 0 and ${WEBSITE_MAX_IMAGES}`,
    );
  }
  return imageCount;
}

function readPrompt(options: WebsiteOptions): string {
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
      'Usage: zero built-in generate website --prompt "A launch site for a developer tool"',
    ),
  });
}

export const websiteCommand = new Command()
  .name("website")
  .description("Prepare website authoring instructions from a prompt")
  .option("--prompt <text>", "Website prompt; can also be piped via stdin")
  .option(
    "--template <template>",
    "Template: auto, launch, or profile",
    parseTemplate,
    "auto",
  )
  .option(
    "--images <count>",
    `Generated website image count: 0-${WEBSITE_MAX_IMAGES}`,
    parseImageCount,
    1,
  )
  .option(
    "--image-model <model>",
    "Image model for generated visuals (default: gpt-image-1): gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, or seedream4",
  )
  .option("--site <slug>", "Hosted site slug; defaults to the generated name")
  .option("--title <text>", "Requested site title or name")
  .option("--audience <text>", "Audience context")
  .option("--json", "Print metadata as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Generate site:         zero built-in generate website --prompt "A launch site for a developer observability tool"
  Pick template:         zero built-in generate website --template profile --images 2 --image-model gpt-image-1.5 --prompt "Portfolio for a robotics photographer"
  Stable hosted slug:    zero built-in generate website --site api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | zero built-in generate website

Output:
  Prints an Open Design registry-selection packet for the current agent.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML artifact and hosts it with zero host`,
  )
  .action(
    withErrorHandler(async (options: WebsiteOptions) => {
      const prompt = readPrompt(options);
      const packet = createHtmlArtifactAuthoringPacket({
        kind: "website",
        prompt,
        slugSource: options.title,
        site: options.site,
        details: [
          `Template direction: ${options.template}`,
          `Suggested generated visual count: ${options.images}`,
          `Image model preference if visuals are generated separately: ${
            options.imageModel ?? "default"
          }`,
          `Requested title/site name: ${options.title ?? "not specified"}`,
          `Audience: ${options.audience ?? "not specified"}`,
        ],
        artifactRules: [
          "Build the usable website as the first screen; do not output a landing-page plan.",
          "If it is a marketing site, make the product or offer visible in the first viewport.",
          "For app or tool surfaces, prioritize dense, scannable, task-focused UI over decorative sections.",
          "Use responsive HTML/CSS and verify the page works at mobile and desktop widths.",
        ],
      });

      if (options.json) {
        console.log(JSON.stringify(packet));
        return;
      }
      console.log(packet.instructions);
    }),
  );
