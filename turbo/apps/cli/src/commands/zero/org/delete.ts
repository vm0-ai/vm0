import { Command } from "commander";
import chalk from "chalk";
import { deleteZeroOrg } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete the current organization (admin only)")
  .argument("<slug>", "Organization slug to confirm deletion")
  .action(
    withErrorHandler(async (slug: string) => {
      await deleteZeroOrg(slug);
      console.log(chalk.green(`✓ Organization '${slug}' has been deleted.`));
    }),
  );
