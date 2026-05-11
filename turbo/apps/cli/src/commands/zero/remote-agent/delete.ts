import { Command } from "commander";
import chalk from "chalk";
import { deleteRemoteAgentHost, listRemoteAgentHosts } from "../../../lib/api";
import { clearRemoteAgentHost } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

async function resolveRemoteAgentHost(target: string): Promise<{
  id: string;
  displayName: string;
}> {
  const { hosts } = await listRemoteAgentHosts();
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
      `Multiple remote-agent hosts are named ${target}. Use the host id from vm0 remote-agent list.`,
    );
  }

  throw new Error(`Remote-agent host not found: ${target}`);
}

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a remote-agent host")
  .argument("<host>", "Host id or name from vm0 remote-agent list")
  .action(
    withErrorHandler(async (target: string) => {
      const host = await resolveRemoteAgentHost(target.trim());
      await deleteRemoteAgentHost(host.id);
      await clearRemoteAgentHost(host.id);
      console.log(
        chalk.green(`Remote-agent host deleted: ${host.displayName}`),
      );
      console.log(chalk.dim(`  Host id: ${host.id}`));
    }),
  );
