import { Command } from "commander";
import chalk from "chalk";
import { claimRemoteAgentDevice } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const connectCommand = new Command()
  .name("connect")
  .description("Connect a remote-agent host with a device code")
  .argument("<device-code>", "Device code shown by the host")
  .action(
    withErrorHandler(async (deviceCode: string) => {
      await claimRemoteAgentDevice({ deviceCode });
      console.log(chalk.green("Remote-agent host connected"));
    }),
  );
