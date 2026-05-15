import { Command } from "commander";
import chalk from "chalk";
import { deleteLocalAgentHost, listLocalAgentHosts } from "../../../lib/api";
import { clearLocalAgentHost } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

async function resolveLocalAgentHost(target: string): Promise<{
  id: string;
  displayName: string;
}> {
  const { hosts } = await listLocalAgentHosts();
  const idMatch = hosts.find((host) => {
    return host.id === target;
  });
  if (idMatch) {
    return { id: idMatch.id, displayName: idMatch.displayName };
  }

  const nameMatches = hosts.filter((host) => {
    return host.displayName === target;
  });
  if (nameMatches.length === 1) {
    const [host] = nameMatches;
    if (host) {
      return { id: host.id, displayName: host.displayName };
    }
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Multiple local-agent hosts are named ${target}. Use the host id from vm0 local-agent list.`,
    );
  }

  throw new Error(`Local-agent host not found: ${target}`);
}

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a local-agent host")
  .argument("<host>", "Host id or name from vm0 local-agent list")
  .action(
    withErrorHandler(async (target: string) => {
      const host = await resolveLocalAgentHost(target.trim());
      await deleteLocalAgentHost(host.id);
      await clearLocalAgentHost(host.id);
      console.log(chalk.green(`Local-agent host deleted: ${host.displayName}`));
      console.log(chalk.dim(`  Host id: ${host.id}`));
    }),
  );
