import { Command } from "commander";
import chalk from "chalk";
import { listZeroOrgSecrets } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all org-level secrets")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroOrgSecrets();

      if (result.secrets.length === 0) {
        console.log(chalk.dim("No org secrets found"));
        console.log();
        console.log("To add an org secret:");
        console.log(
          chalk.cyan("  zero org secret set MY_API_KEY --body <value>"),
        );
        return;
      }

      console.log(chalk.bold("Org Secrets:"));
      console.log();

      for (const secret of result.secrets) {
        console.log(`  ${chalk.cyan(secret.name)}`);
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
