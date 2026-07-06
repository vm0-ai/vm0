import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface PresentationOptions {
  prompt?: string;
  slides: number;
  title?: string;
  siteSlug?: string;
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

function slugifyPresentationSite(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length >= 3 ? slug : "html-artifact";
}

function buildDirectPresentationInstructionPacket(options: {
  readonly prompt: string;
  readonly slides: number;
  readonly title?: string;
  readonly siteSlug?: string;
}): string {
  const site =
    options.siteSlug ??
    slugifyPresentationSite(options.title ?? options.prompt);
  const outputDir = `./generated/mockups/${site}`;
  const hostCommand = `zero host ${outputDir} --site ${site} --artifact-kind presentation-html`;

  return [
    "# Zero generate presentation",
    "",
    "This is a direct HTML presentation authoring packet for the current agent.",
    "Zero is not selecting registry resources for this presentation. Author the deck directly from the user's request and any supplied source material.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`presentation\` at \`${outputDir}/index.html\`.`,
    "- Output mode: `primary-artifact-with-supporting-assets`.",
    "- Supporting images, audio, video, or metadata may live inside the same output directory when the result needs them.",
    "- Treat the output directory as a project bundle when multiple media types are generated, while keeping the HTML entry point primary.",
    "",
    "## Output Contract",
    `- Write the artifact under \`${outputDir}/\`.`,
    `- The entry file must be \`${outputDir}/index.html\`.`,
    "- Keep every local asset inside the same output directory.",
    "- Do not reference files from another project path.",
    "- Use descriptive filenames and canonical HTML: close non-void tags and double-quote attributes.",
    "- Prefer a single self-contained HTML file unless the artifact genuinely needs separate assets.",
    "",
    "## Requested Parameters",
    `- Slide count: ${options.slides}`,
    `- Requested deck title: ${options.title ?? "not specified"}`,
    "",
    "## Authoring Rules",
    "- Think like a presentation designer, not a web page designer.",
    "- Use a fixed 1920x1080 slide canvas and scale it uniformly for smaller viewports.",
    "- Use one section per slide and keep repeated elements in consistent positions.",
    "- Make keyboard navigation work with ArrowLeft, ArrowRight, Home, and End.",
    "- Keep slide text readable from across a room; avoid memo-like walls of text.",
    "- Produce exactly the requested slide count. Do not let reference examples or preview slide counts override the requested count.",
    "- Before authoring, make an internal slide plan with exactly the requested count and map each slide to a narrative role plus a concrete layout device.",
    "- Adapt layout patterns to the requested slide count: for shorter decks, merge or omit lower-priority content roles; for longer decks, split dense sections into multiple focused slides or reuse layout patterns with different substantive content. Do not add decorative, duplicate, or empty filler slides.",
    "- Use reference materials only for structure, spacing, and visual language. Do not inherit or continue any sample subject, sample story, sample copy, sample metrics, preview imagery, or media seed names.",
    "- Derive every presentation image/media choice from the user's requested topic, story, source material, or cited facts.",
    "- Before laying out slides, establish the deck's arc: the opening problem or question, how it develops, and what conclusion lands; every slide should serve a clear narrative role in that arc.",
    "- Vary slide forms across the deck — full-bleed statement, evidence with data, pull quote, section break, summary — and avoid defaulting every slide to title-plus-bullets.",
    "- Each slide carries one idea; prefer a single strong statement over a list, and never exceed three bullets on any slide.",
    "- Avoid generic AI design defaults: no stock SaaS gradients, no emoji-as-icons, no filler stats, no decorative chrome that does not help the artifact.",
    "- Build the actual artifact first, not a marketing explanation of the artifact.",
    "- Make controls and interactions real when they are visible.",
    "- Keep text readable at desktop and mobile preview sizes.",
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
    hostCommand,
    "```",
    "",
    "File upload is a separate delivery channel for when the user needs a local file copy, not another way to preview the same hosted artifact.",
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
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .addHelpText("after", () => {
      return `
Examples:
${config.examples}

Output:
  Prints direct authoring instructions for the current agent.

Notes:
  - Authenticates via ZERO_TOKEN
  - The agent authors the HTML presentation artifact and hosts it with zero host`;
    })
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          prompt: options.prompt,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;

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
