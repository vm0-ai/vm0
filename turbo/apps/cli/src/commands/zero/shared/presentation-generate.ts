import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";
import {
  buildPresentationRunbookInstructionLines,
  findPresentationRunbookPackage,
  listPresentationRunbookPackages,
  resolvePresentationRunbookColorToken,
} from "./resource-registry";
import { canonicalizeRegistryId } from "./resource-listing";
import { createHtmlArtifactOutputPlan } from "./html-artifact-authoring";

type PresentationRunbookPackage = ReturnType<
  typeof listPresentationRunbookPackages
>[number];

interface PresentationOptions {
  prompt?: string;
  slides: number;
  title?: string;
  siteSlug?: string;
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
  if (slideCount < 4 || slideCount > 20) {
    throw new InvalidArgumentError("slides must be between 4 and 20");
  }
  return slideCount;
}

function listPresentationTemplates(): readonly PresentationRunbookPackage[] {
  return listPresentationRunbookPackages();
}

function unknownTemplateError(id: string, usageCommand: string): Error {
  const templates = listPresentationTemplates();
  const message = [
    `Unknown template for presentation: ${id}`,
    "",
    "Available templates for presentation:",
    formatPresentationTemplateListing(templates),
    "",
    "Example:",
    `  ${usageCommand} --template ${
      templates[0]?.templateId ?? "<template-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function formatPresentationTemplateListing(
  templates: readonly PresentationRunbookPackage[],
): string {
  if (templates.length === 0) {
    return "  (no presentation templates registered)";
  }
  return templates
    .map((template) => {
      return `  ${template.templateId}\n    ${template.description}`;
    })
    .join("\n\n");
}

function buildDirectPresentationInstructionPacket(options: {
  readonly prompt: string;
  readonly slides: number;
  readonly title?: string;
  readonly siteSlug?: string;
}): string {
  const output = createHtmlArtifactOutputPlan({
    kind: "presentation",
    prompt: options.prompt,
    slugSource: options.title,
    siteSlug: options.siteSlug,
  });

  return [
    "# Zero generate presentation",
    "",
    "This is a direct HTML presentation authoring packet for the current agent.",
    "Author the deck directly from the user's request and any supplied source material.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Output Contract",
    `- Write the artifact under \`${output.outputDir}/\`.`,
    `- The entry file must be \`${output.primaryArtifactPath}\`.`,
    "- Keep every local asset inside the same output directory.",
    "",
    "## Requested Parameters",
    `- Slide count: ${options.slides}`,
    `- Requested deck title: ${options.title ?? "not specified"}`,
    "",
    "## Authoring Rules",
    "- Use a fixed 1920x1080 slide canvas and one section per slide.",
    "- Make keyboard navigation work with ArrowLeft, ArrowRight, Home, and End.",
    "- Keep slide text readable from across a room; avoid memo-like walls of text.",
    "- Produce exactly the requested slide count; make an internal slide plan before authoring.",
    "- Use reference materials only for structure, spacing, and visual language. Do not inherit or continue any sample subject, sample story, sample copy, sample metrics, preview imagery, or media seed names.",
    "- Derive every presentation image/media choice from the user's requested topic, story, source material, or cited facts.",
    "- Vary slide forms across the deck and keep every slide tied to a clear narrative role.",
    "",
    "## Verification",
    "- Use `agent-browser` for browser verification when available. Start with `agent-browser skills get core` if you need command guidance.",
    "- Prefer `agent-browser` over Playwright, Puppeteer, or installing browser automation dependencies.",
    "- Open the HTML locally and verify it is nonblank.",
    "- Check that keyboard/click interactions work when present.",
    "- Check that text does not overflow or overlap at desktop and mobile viewport sizes.",
    "- Check that shapes, charts, images, or decorative graphics do not cover readable text at desktop and mobile viewport sizes.",
    "- Run the final hosting command only after the artifact looks correct.",
    "",
    "## Publish",
    "The hosted URL is the preview and user-accessible view for this static HTML artifact.",
    "When everything is OK, publish it with:",
    "",
    "```bash",
    output.hostCommand,
    "```",
  ].join("\n");
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
      "--template <id>",
      "Presentation template id (see Templates below). Accepts either 'html-ppt-playful-launch' or 'template:html-ppt-playful-launch'.",
    )
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .addHelpText("after", () => {
      const templates = listPresentationTemplates();
      return `
Examples:
${config.examples}

Output:
  Prints direct authoring instructions for the current agent.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML presentation artifact and hosts it with zero host

Templates (presentation):
${formatPresentationTemplateListing(templates)}`;
    })
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          prompt: options.prompt,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;

        if (options.template !== undefined) {
          const canonical = canonicalizeRegistryId(
            "template",
            options.template,
          );
          const template = findPresentationRunbookPackage(canonical);
          if (!template) {
            throw unknownTemplateError(options.template, config.usageCommand);
          }
          const color = resolvePresentationRunbookColorToken(
            template,
            undefined,
          );
          const colorSystemToken =
            "error" in color ? template.defaultColorSystem : color.token;
          console.log(
            [
              "# Presentation Generation (template)",
              "",
              ...buildPresentationRunbookInstructionLines({
                runbookPackage: template,
                colorSystemToken,
              }),
              "",
              `User request: ${prompt}`,
            ].join("\n"),
          );
          return;
        }

        const instructions = buildDirectPresentationInstructionPacket({
          prompt,
          slides: options.slides,
          title: options.title,
          siteSlug: options.siteSlug,
        });

        console.log(instructions);
      }),
    );
}
