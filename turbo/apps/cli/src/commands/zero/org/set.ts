import { Command } from "commander";
import chalk from "chalk";
import { getZeroOrg, updateZeroOrg } from "../../../lib/api";
import { saveConfig } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";

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
        const existingOrg = await getZeroOrg();

        if (!options.force) {
          throw new Error(
            `You already have an organization: ${existingOrg.slug}`,
            {
              cause: new Error(
                `To change, use: vm0 zero org set ${slug} --force`,
              ),
            },
          );
        }

        const org = await updateZeroOrg({ slug, force: true });
        await saveConfig({ activeOrg: org.slug });
        console.log(chalk.green(`✓ Organization updated to ${org.slug}`));
        console.log();
        console.log("Your agents will now be namespaced as:");
        console.log(chalk.cyan(`  ${org.slug}/<agent-name>`));
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
