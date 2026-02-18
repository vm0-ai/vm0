import chalk from "chalk";
import { stopNgrokTunnel } from "./ngrok";
import { readPid, deletePid } from "./pid-manager";

async function killProcess(service: string): Promise<void> {
  const pid = await readPid(service);
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`✓ Stopped ${service} (PID ${pid})`));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      console.log(chalk.dim(`  ${service} process already stopped`));
    } else {
      throw error;
    }
  }

  await deletePid(service);
}

export async function stopComputerServices(): Promise<void> {
  console.log(chalk.cyan("Stopping computer connector services..."));

  await stopNgrokTunnel();
  console.log(chalk.green("✓ Stopped ngrok tunnel"));

  await killProcess("wsgidav");
}
