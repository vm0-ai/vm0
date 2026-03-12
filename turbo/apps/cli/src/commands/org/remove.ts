import { Command } from "commander";
import chalk from "chalk";
import { removeOrgMember } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove a member from the current organization")
  .argument("<email>", "Email address of the member to remove")
  .action(
    withErrorHandler(async (email: string) => {
      await removeOrgMember(email);
      console.log(chalk.green(`✓ Removed ${email} from organization`));
    }),
  );
