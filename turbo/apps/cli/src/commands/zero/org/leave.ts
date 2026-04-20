import { Command } from "commander";
import chalk from "chalk";
import { leaveZeroOrg, listZeroOrgs, switchZeroOrg } from "../../../lib/api";
import { saveConfig } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(
    withErrorHandler(async () => {
      await leaveZeroOrg();

      const { orgs } = await listZeroOrgs();
      if (orgs.length === 0) {
        await saveConfig({ token: undefined });
        console.log(chalk.green("✓ Left organization."));
        console.log(
          chalk.yellow("No remaining organizations. Run: vm0 auth login"),
        );
        return;
      }

      const nextOrg = orgs[0]!.slug;
      const result = await switchZeroOrg(nextOrg);
      await saveConfig({
        token: result.access_token,
      });
      console.log(chalk.green(`✓ Left organization. Switched to: ${nextOrg}`));
    }),
  );
