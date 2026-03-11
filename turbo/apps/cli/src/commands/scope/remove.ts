import { Command } from "commander";
import chalk from "chalk";
import { removeScopeMember } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove a member from the current scope")
  .argument("<email>", "Email address of the member to remove")
  .action(
    withErrorHandler(async (email: string) => {
      await removeScopeMember(email);
      console.log(chalk.green(`✓ Removed ${email} from scope`));
    }),
  );
