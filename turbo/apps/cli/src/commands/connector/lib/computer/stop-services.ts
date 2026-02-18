import chalk from "chalk";
import { stopNgrokTunnel } from "./ngrok";
import { readPid, deletePid } from "./pid-manager";

async function killProcess(service: string): Promise<void> {
  const pid = await readPid(service);
  if (!pid) {
    return;
  }

  process.kill(pid, "SIGTERM");
  await deletePid(service);
  console.log(chalk.green(`✓ Stopped ${service} (PID ${pid})`));
}

export async function stopComputerServices(): Promise<void> {
  console.log(chalk.cyan("Stopping computer connector services..."));

  await stopNgrokTunnel();
  console.log(chalk.green("✓ Stopped ngrok tunnel"));

  await killProcess("wsgidav");
  await killProcess("proxy");
}
