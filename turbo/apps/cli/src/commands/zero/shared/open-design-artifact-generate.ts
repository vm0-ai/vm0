import { readFileSync } from "node:fs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Command } from "commander";
import { zeroTokenAllowsFeatureSwitch } from "../../../lib/api/zero-token";
import { withErrorHandler } from "../../../lib/command";
import {
  type OpenDesignTarget,
  toOpenDesignTarget,
} from "./open-design-registry";
import { createHtmlArtifactAuthoringPacket } from "./html-artifact-authoring";

interface OpenDesignArtifactOptions {
  prompt?: string;
  site?: string;
  title?: string;
  audience?: string;
  json?: boolean;
}

interface OpenDesignArtifactCommandConfig {
  name: string;
  target: OpenDesignTarget;
  description: string;
  usageCommand: string;
  examples: string;
  details: (options: OpenDesignArtifactOptions) => readonly string[];
  artifactRules: readonly string[];
}

function readPrompt(
  options: OpenDesignArtifactOptions,
  usageCommand: string,
): string {
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
    cause: new Error(`Usage: ${usageCommand} --prompt "A product report"`),
  });
}

export function createOpenDesignArtifactGenerateCommand(
  config: OpenDesignArtifactCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description(config.description)
    .option("--prompt <text>", "Artifact prompt; can also be piped via stdin")
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
  Prints an Open Design resource-selection packet for the current agent. The
  agent authors a static HTML artifact and hosts it with zero host.

Notes:
  - Authenticates via ZERO_TOKEN
  - OpenDesign path is gated by the openDesignGenerate feature switch`,
    )
    .action(
      withErrorHandler(async (options: OpenDesignArtifactOptions) => {
        if (
          !zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.OpenDesignGenerate)
        ) {
          throw new Error(
            `${config.usageCommand} requires the openDesignGenerate feature switch`,
          );
        }

        const prompt = readPrompt(options, config.usageCommand);
        const packet = createHtmlArtifactAuthoringPacket({
          kind: toOpenDesignTarget(config.target),
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
