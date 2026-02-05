import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpGet, type ApiError } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils/file-utils";

interface Permission {
  id: string;
  granteeType: string;
  granteeEmail: string | null;
  permission: string;
  grantedBy: string;
  createdAt: string;
}

interface PermissionsResponse {
  permissions: Permission[];
}

export const permissionCommand = new Command()
  .name("experimental-permission")
  .description("List all permissions for an agent")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    try {
      // Resolve compose by name
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent not found: ${name}`));
        process.exit(1);
      }

      // Get permissions
      const response = await httpGet(
        `/api/agent/composes/${compose.id}/permissions`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Failed to list permissions");
      }

      const data = (await response.json()) as PermissionsResponse;

      if (data.permissions.length === 0) {
        console.log(chalk.dim("No permissions set (private agent)"));
        return;
      }

      // Print header
      console.log(
        chalk.dim(
          "TYPE     EMAIL                          PERMISSION  GRANTED",
        ),
      );
      console.log(
        chalk.dim(
          "-------  -----------------------------  ----------  ----------",
        ),
      );

      // Print rows
      for (const p of data.permissions) {
        const type = p.granteeType.padEnd(7);
        const email = (p.granteeEmail ?? "-").padEnd(29);
        const permission = p.permission.padEnd(10);
        const granted = formatRelativeTime(p.createdAt);
        console.log(`${type}  ${email}  ${permission}  ${granted}`);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list permissions"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
