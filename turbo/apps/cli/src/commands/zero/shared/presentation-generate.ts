import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";
import {
  findDesignSystem,
  findTemplate,
  listDesignSystems,
  listTemplates,
} from "./resource-registry";
import {
  canonicalizeRegistryId,
  formatRegistryListing,
} from "./resource-listing";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

const PRESENTATION_TARGET = "presentation";

interface PresentationOptions {
  prompt?: string;
  slides: number;
  title?: string;
  siteSlug?: string;
  designSystem?: string;
  template?: string;
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

function unknownDesignSystemError(id: string, usageCommand: string): Error {
  const designSystems = listDesignSystems();
  const message = [
    `Unknown design system: ${id}`,
    "",
    "Available design systems:",
    formatRegistryListing(designSystems, "design systems"),
    "",
    `Example:`,
    `  ${usageCommand} --design-system ${
      designSystems[0]?.id ?? "<design-system-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function unknownTemplateError(
  id: string,
  usageCommand: string,
  target: string,
): Error {
  const templates = listTemplates(PRESENTATION_TARGET);
  const message = [
    `Unknown template for ${target}: ${id}`,
    "",
    `Available templates for ${target}:`,
    formatRegistryListing(templates, `${target} templates`),
    "",
    `Example:`,
    `  ${usageCommand} --template ${
      templates[0]?.id ?? "<template-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
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
    .option("--site-slug <slug>", "Hosted site slug override")
    .option("--title <text>", "Requested deck title")
    .option(
      "--design-system <id>",
      "Design system id from the registry (see Design Systems below). Accepts either 'apple' or 'design-system:apple'.",
    )
    .option(
      "--template <id>",
      "Template id from the registry, scoped to presentation (see Templates below). Accepts either 'html-ppt-pitch-deck' or 'template:html-ppt-pitch-deck'.",
    )
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .addHelpText("after", () => {
      const designSystems = listDesignSystems();
      const templates = listTemplates(PRESENTATION_TARGET);
      return `
Examples:
${config.examples}

Output:
  Prints a source-selection packet for the current agent.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML presentation artifact and hosts it with zero host

Design Systems:
${formatRegistryListing(designSystems, "design systems")}

Templates (presentation):
${formatRegistryListing(templates, "presentation templates")}`;
    })
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
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
            throw unknownDesignSystemError(
              options.designSystem,
              config.usageCommand,
            );
          }
          resolvedDesignSystem = entry;
        }

        let resolvedTemplate;
        if (options.template !== undefined) {
          const canonical = canonicalizeRegistryId(
            "template",
            options.template,
          );
          const entry = findTemplate(canonical);
          if (!entry || !entry.targets?.includes(PRESENTATION_TARGET)) {
            throw unknownTemplateError(
              options.template,
              config.usageCommand,
              PRESENTATION_TARGET,
            );
          }
          resolvedTemplate = entry;
        }

        const packet = createHtmlArtifactAuthoringPacket({
          kind: "presentation",
          prompt,
          slugSource: options.title,
          siteSlug: options.siteSlug,
          details: [
            `Slide count: ${options.slides}`,
            `Requested deck title: ${options.title ?? "not specified"}`,
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
            "Think like a presentation designer, not a web page designer.",
            "Use a fixed 1920x1080 slide canvas and scale it uniformly for smaller viewports.",
            "Use one section per slide and keep repeated elements in consistent positions.",
            "Make keyboard navigation work with ArrowLeft, ArrowRight, Home, and End.",
            "Keep slide text readable from across a room; avoid memo-like walls of text.",
            "Before laying out slides, establish the deck's arc: the opening problem or question, how it develops, and what conclusion lands; every slide should serve a clear narrative role in that arc.",
            "Vary slide forms across the deck — full-bleed statement, evidence with data, pull quote, section break, summary — and avoid defaulting every slide to title-plus-bullets.",
            "Each slide carries one idea; prefer a single strong statement over a list, and never exceed three bullets on any slide.",
          ],
        });

        console.log(packet.instructions);
      }),
    );
}
