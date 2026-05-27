import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "../shared/html-artifact-authoring";
import { dispatchGenerate } from "./lib/dispatch";

const WEBSITE_TEMPLATES = ["auto", "launch", "profile"] as const;
const WEBSITE_MAX_IMAGES = 3;

interface WebsiteOptions {
  readonly prompt?: string;
  readonly provider?: string;
  readonly template: string;
  readonly images: number;
  readonly imageModel?: string;
  readonly site?: string;
  readonly title?: string;
  readonly audience?: string;
  readonly all?: boolean;
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

export const websiteCommand = new Command()
  .name("website")
  .description("Prepare website authoring instructions from a prompt")
  .option("--prompt <text>", "Website prompt; can also be piped via stdin")
  .option(
    "--provider <name>",
    "Provider: 'built-in' to run vm0's pipeline, or a connector name to get its skill-invocation guidance",
  )
  .option(
    "--all",
    "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
  )
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
  Generate site:         zero generate website --prompt "A launch site for a developer observability tool"
  Pick template:         zero generate website --template profile --images 2 --image-model gpt-image-1.5 --prompt "Portfolio for a robotics photographer"
  Stable hosted slug:    zero generate website --site api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | zero generate website
  List providers:        zero generate website

Output:
  Prints an Open Design registry-selection packet for the current agent.
  With no --prompt and no piped input, prints the provider menu instead.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML artifact and hosts it with zero host`,
  )
  .action(
    withErrorHandler(async (options: WebsiteOptions) => {
      const dispatch = await dispatchGenerate({
        generationType: "website",
        provider: options.provider,
        prompt: options.prompt,
        all: options.all,
        json: options.json,
      });
      if (dispatch.outcome === "handled") return;
      const prompt = dispatch.prompt;

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
