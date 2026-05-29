import { Command } from "commander";
import { withErrorHandler } from "../../../lib/command";
import {
  findDesignSystem,
  findTemplate,
  listDesignSystems,
  listTemplates,
  type GenerationTarget,
  toGenerationTarget,
} from "./resource-registry";
import {
  canonicalizeRegistryId,
  formatRegistryListing,
} from "./resource-listing";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface ArtifactOptions {
  prompt?: string;
  provider?: string;
  siteSlug?: string;
  title?: string;
  designSystem?: string;
  template?: string;
  all?: boolean;
  json?: boolean;
}

interface ArtifactCommandConfig {
  name: string;
  generationType: GenerationType;
  target: GenerationTarget;
  description: string;
  usageCommand: string;
  examples: string;
  details: (options: ArtifactOptions) => readonly string[];
  artifactRules: readonly string[];
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
  target: GenerationTarget,
): Error {
  const templates = listTemplates(target);
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

export function createArtifactGenerateCommand(
  config: ArtifactCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description(config.description)
    .option("--prompt <text>", "Artifact prompt; can also be piped via stdin")
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run vm0's pipeline, or a connector name to get its skill-invocation guidance",
    )
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
    )
    .option("--site-slug <slug>", "Hosted site slug override")
    .option("--title <text>", "Requested artifact title or name")
    .option(
      "--design-system <id>",
      "Design system id from the registry (see Design Systems below). Accepts either 'apple' or 'design-system:apple'.",
    )
    .option(
      "--template <id>",
      `Template id from the registry, scoped to ${config.target} (see Templates below). Accepts either short id or full 'template:<id>'.`,
    )
    .option("--json", "Print metadata as JSON")
    .addHelpText("after", () => {
      const designSystems = listDesignSystems();
      const templates = listTemplates(config.target);
      return `
Examples:
${config.examples}

Output:
  Prints a source-selection packet for the current agent. The
  agent authors a static HTML artifact and hosts it with zero host. With no
  --prompt and no piped input, prints the provider menu instead.

Notes:
  - Authenticates via ZERO_TOKEN

Design Systems:
${formatRegistryListing(designSystems, "design systems")}

Templates (${config.target}):
${formatRegistryListing(templates, `${config.target} templates`)}`;
    })
    .action(
      withErrorHandler(async (options: ArtifactOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
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
          if (!entry || !entry.targets?.includes(config.target)) {
            throw unknownTemplateError(
              options.template,
              config.usageCommand,
              config.target,
            );
          }
          resolvedTemplate = entry;
        }

        const extraDetails = [
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
        ];

        const packet = createHtmlArtifactAuthoringPacket({
          kind: toGenerationTarget(config.target),
          prompt,
          slugSource: options.title,
          siteSlug: options.siteSlug,
          details: [...config.details(options), ...extraDetails],
          artifactRules: config.artifactRules,
        });

        if (options.json) {
          console.log(JSON.stringify(packet));
          return;
        }

        console.log(packet.instructions);
      }),
    );
}
