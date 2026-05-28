import { Command } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { type GenerationTarget, toGenerationTarget } from "./resource-registry";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface ArtifactOptions {
  prompt?: string;
  provider?: string;
  site?: string;
  title?: string;
  audience?: string;
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
    .option("--site <slug>", "Hosted site slug; defaults to generated name")
    .option("--title <text>", "Requested artifact title or name")
    .option("--audience <text>", "Audience context")
    .option("--json", "Print metadata as JSON")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints a source-selection packet for the current agent. The
  agent authors a static HTML artifact and hosts it with zero host. With no
  --prompt and no piped input, prints the provider menu instead.

Notes:
  - Authenticates via ZERO_TOKEN`,
    )
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

        const packet = createHtmlArtifactAuthoringPacket({
          kind: toGenerationTarget(config.target),
          prompt,
          slugSource: options.title,
          site: options.site,
          details: config.details(options),
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
