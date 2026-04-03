import { Command } from "commander";
import chalk from "chalk";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  registerComputerUseHost,
  unregisterComputerUseHost,
} from "../../../lib/api";
import {
  getRandomPort,
  startDesktopServer,
} from "../../../lib/computer-use/desktop-server";
import {
  startDesktopTunnel,
  stopDesktopTunnel,
} from "../../../lib/computer-use/ngrok";

export const hostStartCommand = new Command()
  .name("start")
  .description("Start the computer-use host daemon (macOS only)")
  .action(
    withErrorHandler(async () => {
      if (process.platform !== "darwin") {
        throw new Error(
          "Computer-use host requires macOS\n\n" +
            "The host daemon uses macOS-specific commands (screencapture, system_profiler).",
        );
      }

      console.log(chalk.cyan("Registering computer-use host..."));
      const credentials = await registerComputerUseHost();

      const port = await getRandomPort();
      const server = await startDesktopServer(credentials.token, port);

      try {
        await startDesktopTunnel(
          credentials.ngrokToken,
          credentials.endpointPrefix,
          port,
        );

        console.log();
        console.log(chalk.green("✓ Computer-use host active"));
        console.log(`  Desktop: desktop.${credentials.domain}`);
        console.log();
        console.log(chalk.dim("Press ^C twice to disconnect"));
        console.log();

        let sigintCount = 0;
        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 60_000);
          const done = () => {
            clearInterval(keepAlive);
            process.removeListener("SIGINT", onSigint);
            resolve();
          };
          const onSigint = () => {
            sigintCount++;
            if (sigintCount === 1) {
              console.log(
                chalk.dim("\nPress ^C again to disconnect and exit..."),
              );
            } else {
              done();
            }
          };
          process.on("SIGINT", onSigint);
          process.once("SIGTERM", done);
        });
      } finally {
        console.log();
        console.log(chalk.cyan("Stopping computer-use host..."));
        server.close();
        await stopDesktopTunnel();
        await unregisterComputerUseHost().catch(() => {});
        console.log(chalk.green("✓ Host stopped"));
      }
    }),
  );
