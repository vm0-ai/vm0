import { Command } from "commander";
import chalk from "chalk";
import { getConnectorEnvNamesForSecret } from "@vm0/connectors/connector-utils";
import { listZeroSecrets } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all secrets")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroSecrets();

      if (result.secrets.length === 0) {
        console.log(chalk.dim("No secrets found"));
        console.log();
        console.log("To add a secret:");
        console.log(chalk.cyan("  zero secret set MY_API_KEY --body <value>"));
        return;
      }

      console.log(chalk.bold("Secrets:"));
      console.log();

      for (const secret of result.secrets) {
        let typeIndicator = "";
        let derivedLine: string | null = null;

        if (secret.type === "model-provider") {
          typeIndicator = chalk.dim(" [model-provider]");
        } else if (secret.type === "connector") {
          const derived = getConnectorEnvNamesForSecret(secret.name);
          if (derived) {
            typeIndicator = chalk.dim(` [${derived.connectorLabel} connector]`);
            derivedLine = chalk.dim(
              `Available as: ${derived.envNames.join(", ")}`,
            );
          } else {
            typeIndicator = chalk.dim(" [connector]");
          }
        } else if (secret.type === "user") {
          const derived = getConnectorEnvNamesForSecret(secret.name);
          if (derived) {
            typeIndicator = chalk.dim(` [${derived.connectorLabel} connector]`);
            derivedLine = chalk.dim(
              `Available as: ${derived.envNames.join(", ")}`,
            );
          }
        }

        console.log(`  ${chalk.cyan(secret.name)}${typeIndicator}`);
        if (derivedLine) {
          console.log(`    ${derivedLine}`);
        }
        if (secret.description) {
          console.log(`    ${chalk.dim(secret.description)}`);
        }
        console.log(
          `    ${chalk.dim(`Updated: ${new Date(secret.updatedAt).toLocaleString()}`)}`,
        );
        console.log();
      }

      console.log(chalk.dim(`Total: ${result.secrets.length} secret(s)`));
    }),
  );
