import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "../shared/html-artifact-authoring";
import {
  findDesignSystem,
  findTemplate,
  listDesignSystems,
  listTemplates,
} from "../shared/resource-registry";
import {
  canonicalizeRegistryId,
  formatRegistryListing,
} from "../shared/resource-listing";
import { dispatchGenerate } from "./lib/dispatch";

const WEBSITE_TEMPLATE_DIRECTIONS = ["auto", "launch", "profile"] as const;
const WEBSITE_MAX_IMAGES = 3;
const WEBSITE_TARGET = "website";
const WEBSITE_USAGE_COMMAND = "zero generate website";

interface WebsiteOptions {
  readonly prompt?: string;
  readonly provider?: string;
  readonly templateDirection: string;
  readonly template?: string;
  readonly designSystem?: string;
  readonly images: number;
  readonly imageModel?: string;
  readonly site?: string;
  readonly title?: string;
  readonly audience?: string;
  readonly all?: boolean;
  readonly json?: boolean;
}

function parseTemplateDirection(value: string): string {
  if (
    WEBSITE_TEMPLATE_DIRECTIONS.some((direction) => {
      return direction === value;
    })
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    "template-direction must be auto, launch, or profile",
  );
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

function unknownDesignSystemError(id: string): Error {
  const designSystems = listDesignSystems();
  const message = [
    `Unknown design system: ${id}`,
    "",
    "Available design systems:",
    formatRegistryListing(designSystems, "design systems"),
    "",
    `Example:`,
    `  ${WEBSITE_USAGE_COMMAND} --design-system ${
      designSystems[0]?.id ?? "<design-system-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function unknownTemplateError(id: string): Error {
  const templates = listTemplates(WEBSITE_TARGET);
  const message = [
    `Unknown template for ${WEBSITE_TARGET}: ${id}`,
    "",
    `Available templates for ${WEBSITE_TARGET}:`,
    formatRegistryListing(templates, `${WEBSITE_TARGET} templates`),
    "",
    `Example:`,
    `  ${WEBSITE_USAGE_COMMAND} --template ${
      templates[0]?.id ?? "<template-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
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
    "--template-direction <direction>",
    "High-level website direction: auto, launch, or profile",
    parseTemplateDirection,
    "auto",
  )
  .option(
    "--template <id>",
    "Template id from the registry, scoped to website (see Templates below). Accepts either short id or full 'template:<id>'.",
  )
  .option(
    "--design-system <id>",
    "Design system id from the registry (see Design Systems below). Accepts either 'apple' or 'design-system:apple'.",
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
  .addHelpText("after", () => {
    const designSystems = listDesignSystems();
    const templates = listTemplates(WEBSITE_TARGET);
    return `
Examples:
  Generate site:         zero generate website --prompt "A launch site for a developer observability tool"
  Pick direction:        zero generate website --template-direction profile --images 2 --image-model gpt-image-1.5 --prompt "Portfolio for a robotics photographer"
  Pick template:         zero generate website --template saas-landing --prompt "Launch site for a billing API"
  Pick design system:    zero generate website --design-system stripe --prompt "Pricing page for a SaaS"
  Stable hosted slug:    zero generate website --site api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | zero generate website
  List providers:        zero generate website

Output:
  Prints a source-selection packet for the current agent.
  With no --prompt and no piped input, prints the provider menu instead.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML artifact and hosts it with zero host

Design Systems:
${formatRegistryListing(designSystems, "design systems")}

Templates (website):
${formatRegistryListing(templates, "website templates")}`;
  })
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

      let resolvedDesignSystem;
      if (options.designSystem !== undefined) {
        const canonical = canonicalizeRegistryId(
          "design-system",
          options.designSystem,
        );
        const entry = findDesignSystem(canonical);
        if (!entry) {
          throw unknownDesignSystemError(options.designSystem);
        }
        resolvedDesignSystem = entry;
      }

      let resolvedTemplate;
      if (options.template !== undefined) {
        const canonical = canonicalizeRegistryId("template", options.template);
        const entry = findTemplate(canonical);
        if (!entry || !entry.targets?.includes(WEBSITE_TARGET)) {
          throw unknownTemplateError(options.template);
        }
        resolvedTemplate = entry;
      }

      const packet = createHtmlArtifactAuthoringPacket({
        kind: "website",
        prompt,
        slugSource: options.title,
        site: options.site,
        details: [
          `Template direction: ${options.templateDirection}`,
          `Suggested generated visual count: ${options.images}`,
          `Image model preference if visuals are generated separately: ${
            options.imageModel ?? "default"
          }`,
          `Requested title/site name: ${options.title ?? "not specified"}`,
          `Audience: ${options.audience ?? "not specified"}`,
          `Selected design system: ${
            resolvedDesignSystem
              ? `${resolvedDesignSystem.id} (${resolvedDesignSystem.name})`
              : "agent decides"
          }`,
          `Selected template: ${
            resolvedTemplate
              ? `${resolvedTemplate.id} (${resolvedTemplate.name})`
              : "agent decides"
          }`,
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
