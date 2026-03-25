import { Command } from "commander";
import chalk from "chalk";
import { getZeroOrg, updateZeroOrg, switchZeroOrg } from "../../../lib/api";
import { saveConfig, getToken } from "../../../lib/api/config";
import { decodeCliTokenPayload } from "../../../lib/api/cli-token";
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
              cause: new Error(`To change, use: zero org set ${slug} --force`),
            },
          );
        }

        const org = await updateZeroOrg({ slug, force: true });

        const token = await getToken();
        if (decodeCliTokenPayload(token)) {
          // JWT flow: get new token with updated org context
          const result = await switchZeroOrg(org.slug);
          await saveConfig({
            token: result.access_token,
            activeOrg: result.org_slug,
          });
        } else {
          await saveConfig({ activeOrg: org.slug });
        }

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
