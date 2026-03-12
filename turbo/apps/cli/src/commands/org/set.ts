import { Command } from "commander";
import chalk from "chalk";
import { getOrg, updateOrg } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const setCommand = new Command()
  .name("set")
  .description("Rename your organization slug")
  .argument("<slug>", "The new organization slug")
  .option(
    "--force",
    "Force change existing organization (may break references)",
  )
  .action(
    withErrorHandler(async (slug: string, options: { force?: boolean }) => {
      try {
        const existingScope = await getOrg();

        if (!options.force) {
          throw new Error(
            `You already have an organization: ${existingScope.slug}`,
            {
              cause: new Error(`To change, use: vm0 org set ${slug} --force`),
            },
          );
        }

        const scope = await updateOrg({ slug, force: true });
        console.log(chalk.green(`✓ Organization updated to ${scope.slug}`));
        console.log();
        console.log("Your agents will now be namespaced as:");
        console.log(chalk.cyan(`  ${scope.slug}/<agent-name>`));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          throw new Error(
            `Organization "${slug}" is already taken. Please choose a different slug.`,
          );
        }
        throw error;
      }
    }),
  );
