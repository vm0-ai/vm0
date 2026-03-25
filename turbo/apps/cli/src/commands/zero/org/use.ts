import { Command } from "commander";
import chalk from "chalk";
import { listZeroOrgs, switchZeroOrg } from "../../../lib/api";
import { saveConfig, getToken } from "../../../lib/api/config";
import { decodeCliTokenPayload } from "../../../lib/api/cli-token";
import { withErrorHandler } from "../../../lib/command";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different organization")
  .argument("<slug>", "Organization slug to switch to")
  .action(
    withErrorHandler(async (slug: string) => {
      const orgList = await listZeroOrgs();
      const target = orgList.orgs.find((s) => s.slug === slug);
      if (!target) {
        throw new Error(`Organization '${slug}' not found or not accessible.`);
      }

      const token = await getToken();
      if (decodeCliTokenPayload(token)) {
        // JWT flow: get new token from server
        const result = await switchZeroOrg(slug);
        await saveConfig({
          token: result.access_token,
          activeOrg: result.org_slug,
        });
      } else {
        // Legacy flow: just update config
        await saveConfig({ activeOrg: slug });
      }
      console.log(chalk.green(`✓ Switched to organization: ${slug}`));
    }),
  );
