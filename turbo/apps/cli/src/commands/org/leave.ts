import { Command } from "commander";
import chalk from "chalk";
import { leaveOrg, listOrgs } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(
    withErrorHandler(async () => {
      await leaveOrg();

      const { orgs } = await listOrgs();
      if (orgs.length === 0) {
        await saveConfig({ activeOrg: undefined });
        console.log(chalk.green("✓ Left organization."));
        console.log(
          chalk.yellow("No remaining organizations. Run: vm0 auth login"),
        );
        return;
      }

      const nextOrg = orgs[0]!.slug;
      await saveConfig({ activeOrg: nextOrg });
      console.log(chalk.green(`✓ Left organization. Switched to: ${nextOrg}`));
    }),
  );
