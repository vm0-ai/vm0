import { spawn } from "child_process";
import { open } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { startNgrokTunnel } from "./ngrok";
import { writePid, getLogPath, ensurePidDir } from "./pid-manager";

interface ComputerConnectorCredentials {
  ngrokToken: string;
  bridgeToken: string;
  endpointPrefix: string;
  domain: string;
}

async function checkCommandExists(command: string): Promise<boolean> {
  const { spawn } = await import("child_process");
  return new Promise((resolve) => {
    const child = spawn("which", [command]);
    child.on("close", (code) => resolve(code === 0));
  });
}

async function startWsgidav(): Promise<number> {
  const wsgidavExists = await checkCommandExists("wsgidav");
  if (!wsgidavExists) {
    throw new Error(
      "wsgidav not found\n\nInstall with: pip install wsgidav[cheroot]",
    );
  }

  const downloadsPath = join(homedir(), "Downloads");
  await ensurePidDir();
  const logPath = getLogPath("wsgidav");
  const logFile = await open(logPath, "w");

  const child = spawn(
    "wsgidav",
    [
      "--host=127.0.0.1",
      "--port=8888",
      `--root=${downloadsPath}`,
      "--auth=anonymous",
      "--no-config",
    ],
    {
      detached: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
    },
  );

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to start wsgidav");
  }

  return child.pid;
}

export async function startComputerServices(
  credentials: ComputerConnectorCredentials,
): Promise<void> {
  console.log(chalk.cyan("Starting computer connector services..."));

  const wsgidavPid = await startWsgidav();
  await writePid("wsgidav", wsgidavPid);
  console.log(chalk.green("✓ WebDAV server started"));

  await startNgrokTunnel(credentials.ngrokToken, credentials.endpointPrefix);
  console.log(
    chalk.green(
      `✓ ngrok tunnel: webdav.${credentials.endpointPrefix}.internal`,
    ),
  );

  console.log();
  console.log(chalk.green("✓ Computer connector active"));
  console.log(`  Cloud Endpoint: https://*.${credentials.domain}`);
  console.log(`  WebDAV: ~/Downloads exposed to agents`);
  console.log();
  console.log(chalk.cyan("Connection details:"));
  console.log(`  Domain: ${credentials.domain}`);
  console.log(`  Bridge Token: ${credentials.bridgeToken}`);
}
