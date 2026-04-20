import { Command } from "commander";
import chalk from "chalk";
import { listZeroOrgs, switchZeroOrg } from "../../../lib/api";
import { saveConfig } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different organization")
  .argument("<slug>", "Organization slug to switch to")
  .action(
    withErrorHandler(async (slug: string) => {
      const orgList = await listZeroOrgs();
      const target = orgList.orgs.find((s) => {
        return s.slug === slug;
      });
      if (!target) {
        throw new Error(`Organization '${slug}' not found or not accessible.`);
      }

      const result = await switchZeroOrg(slug);
      await saveConfig({
        token: result.access_token,
      });
      console.log(chalk.green(`✓ Switched to organization: ${slug}`));
    }),
  );
