import { Command } from "commander";
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

const WEBSITE_TARGET = "website";
const WEBSITE_USAGE_COMMAND = "zero generate website";

interface WebsiteOptions {
  readonly prompt?: string;
  readonly template?: string;
  readonly designSystem?: string;
  readonly siteSlug?: string;
  readonly title?: string;
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
  .option("--site-slug <slug>", "Hosted site slug override")
  .option("--title <text>", "Requested site title or name")
  .option(
    "--design-system <id>",
    "Design system id from the registry (see Design Systems below). Accepts either 'apple' or 'design-system:apple'.",
  )
  .option(
    "--template <id>",
    "Template id from the registry, scoped to website (see Templates below). Accepts either short id or full 'template:<id>'.",
  )
  .addHelpText("after", () => {
    const designSystems = listDesignSystems();
    const templates = listTemplates(WEBSITE_TARGET);
    return `
Examples:
  Generate site:         zero generate website --prompt "A launch site for a developer observability tool"
  Pick template:         zero generate website --template saas-landing --prompt "Launch site for a billing API"
  Pick design system:    zero generate website --design-system stripe --prompt "Pricing page for a SaaS"
  Stable hosted slug:    zero generate website --site-slug api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | zero generate website
  Show choices:          zero generate website

Output:
  Prints a source-selection packet for the current agent.
  With no --prompt and no piped input, prints the generation choices instead.

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
        prompt: options.prompt,
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
        siteSlug: options.siteSlug,
        details: [
          `Requested title/site name: ${options.title ?? "not specified"}`,
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

      console.log(packet.instructions);
    }),
  );
