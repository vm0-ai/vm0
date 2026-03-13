import { Command } from "commander";
import chalk from "chalk";
import { listOrgs } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const useCommand = new Command()
  .name("use")
  .description("Switch to a different organization")
  .argument("[slug]", "Organization slug to switch to")
  .option("--personal", "Switch to personal org")
  .action(
    withErrorHandler(
      async (slug: string | undefined, options: { personal?: boolean }) => {
        if (options.personal) {
          await saveConfig({ activeOrg: undefined });
          console.log(chalk.green("✓ Switched to personal org."));
          return;
        }

        if (!slug) {
          throw new Error(
            "Organization slug is required. Use --personal to switch to personal org.",
          );
        }

        // Verify the organization exists and user has access
        const orgList = await listOrgs();
        const target = orgList.orgs.find((s) => s.slug === slug);
        if (!target) {
          throw new Error(
            `Organization '${slug}' not found or not accessible.`,
          );
        }

        await saveConfig({ activeOrg: slug });
        console.log(chalk.green(`✓ Switched to organization: ${slug}`));
      },
    ),
  );
