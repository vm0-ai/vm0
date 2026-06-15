import { Command } from "commander";
import { withErrorHandler } from "../../../lib/command";
import { printConnectorGuidance } from "./lib/connector-guidance";
import { runLister, type GenerationType } from "./lib/lister";

interface ListerOnlyOptions {
  readonly provider?: string;
  readonly all?: boolean;
}

interface ListerOnlyConfig {
  readonly name: string;
  readonly generationType: GenerationType;
  readonly description: string;
}

/**
 * Build a generate subcommand for a type that has no vm0 built-in pipeline.
 * The command lists available connector providers and prints skill-invocation
 * guidance when a --provider is named, but cannot execute on its own.
 */
export function createListerOnlyCommand(config: ListerOnlyConfig): Command {
  return new Command()
    .name(config.name)
    .description(config.description)
    .option(
      "--provider <name>",
      "Connector name; prints that connector's skill-invocation guidance",
    )
    .option("--all", "Include unavailable or not-yet-authorized connectors")
    .addHelpText(
      "after",
      `
Notes:
  - vm0 does not provide a built-in ${config.generationType} pipeline.
  - Use --provider <connector-name> to get skill-invocation guidance for a
    specific connector, or run with no flags to see every available provider.`,
    )
    .action(
      withErrorHandler(async (options: ListerOnlyOptions) => {
        const provider = options.provider?.trim();
        if (provider && provider !== "built-in") {
          printConnectorGuidance(config.generationType, provider);
          return;
        }
        if (provider === "built-in") {
          console.log(
            `vm0 has no built-in ${config.generationType} generation pipeline.`,
          );
          console.log("");
          console.log(
            `Run "zero generate ${config.generationType}" to see every connector-backed provider.`,
          );
          return;
        }
        await runLister(config.generationType, {
          all: options.all,
        });
      }),
    );
}
