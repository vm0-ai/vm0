import { Command } from "commander";
import chalk from "chalk";
import { getZeroOrg } from "../../../lib/api";
import { ApiRequestError } from "../../../lib/api/core/client-factory";
import { withErrorHandler } from "../../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("View current organization status")
  .action(
    withErrorHandler(async () => {
      try {
        const org = await getZeroOrg();

        console.log(chalk.bold("Organization Information:"));
        console.log(`  Slug: ${chalk.green(org.slug)}`);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          throw new Error("No organization configured", {
            cause: new Error(
              "Set your organization with: vm0 zero org set <slug>",
            ),
          });
        }
        throw error;
      }
    }),
  );
