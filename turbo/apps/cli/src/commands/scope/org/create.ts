import { Command } from "commander";
import chalk from "chalk";
import { createOrg } from "../../../lib/api";

export const createCommand = new Command()
  .name("create")
  .description("Create a new organization")
  .argument("<slug>", "The organization slug (e.g., acme)")
  .action(async (slug: string) => {
    try {
      const org = await createOrg({ slug });

      console.log(chalk.green(`✓ Organization created: ${org.slug}`));
      console.log();
      console.log("To start using this organization:");
      console.log(chalk.cyan(`  vm0 scope use ${org.slug}`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (error.message.includes("already owns")) {
          console.error(
            chalk.red(
              "✗ You already own an organization. Each user can only own one organization.",
            ),
          );
        } else if (error.message.includes("already exists")) {
          console.error(
            chalk.red(
              `✗ Organization slug "${slug}" is already taken. Please choose a different slug.`,
            ),
          );
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
