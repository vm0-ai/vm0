import { spawn } from "child_process";
import { access, constants } from "fs/promises";
import { createServer } from "net";
import type { AddressInfo } from "net";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { startNgrokTunnels, stopNgrokTunnels } from "./ngrok";

interface ComputerConnectorCredentials {
  ngrokToken: string;
  bridgeToken: string;
  endpointPrefix: string;
  domain: string;
}

const CHROME_CANDIDATES = [
  // macOS absolute paths
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux / PATH-based
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium",
  "chrome",
];

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        return resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function findBinary(...candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.startsWith("/")) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not found, try next
      }
    } else {
      const found = await new Promise<boolean>((resolve) => {
        const child = spawn("which", [candidate]);
        child.on("close", (code) => {
          return resolve(code === 0);
        });
      });
      if (found) return candidate;
    }
  }
  return null;
}

export async function checkComputerDependencies(): Promise<void> {
  const wsgidavBinary = await findBinary("wsgidav");
  if (!wsgidavBinary) {
    throw new Error(
      "wsgidav not found\n\nInstall with: pip install wsgidav[cheroot]",
    );
  }

  const chromeBinary = await findBinary(...CHROME_CANDIDATES);
  if (!chromeBinary) {
    throw new Error("Chrome not found\n\nInstall Google Chrome or Chromium");
  }
}

export async function startComputerServices(
  credentials: ComputerConnectorCredentials,
): Promise<void> {
  console.log(chalk.cyan("Starting computer connector services..."));

  const wsgidavBinary = await findBinary("wsgidav");
  if (!wsgidavBinary) {
    throw new Error(
      "wsgidav not found\n\nInstall with: pip install wsgidav[cheroot]",
    );
  }

  const chromeBinary = await findBinary(...CHROME_CANDIDATES);
  if (!chromeBinary) {
    throw new Error("Chrome not found\n\nInstall Google Chrome or Chromium");
  }

  const webdavPort = await getRandomPort();
  const cdpPort = await getRandomPort();

  const downloadsPath = join(homedir(), "Downloads");
  const wsgidav = spawn(
    wsgidavBinary,
    [
      "--host=127.0.0.1",
      `--port=${webdavPort}`,
      `--root=${downloadsPath}`,
      "--auth=anonymous",
      "--no-config",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  wsgidav.stdout?.on("data", (data: Buffer) => {
    return process.stdout.write(data);
  });
  wsgidav.stderr?.on("data", (data: Buffer) => {
    return process.stderr.write(data);
  });
  console.log(chalk.green("✓ WebDAV server started"));

  const chrome = spawn(
    chromeBinary,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  chrome.stdout?.on("data", (data: Buffer) => {
    return process.stdout.write(data);
  });
  chrome.stderr?.on("data", (data: Buffer) => {
    return process.stderr.write(data);
  });
  console.log(chalk.green("✓ Chrome started"));

  try {
    await startNgrokTunnels(
      credentials.ngrokToken,
      credentials.endpointPrefix,
      webdavPort,
      cdpPort,
    );
    console.log(
      chalk.green(
        `✓ ngrok tunnels: webdav.${credentials.domain}, chrome.${credentials.domain}`,
      ),
    );

    console.log();
    console.log(chalk.green("✓ Computer connector active"));
    console.log(`  WebDAV:     ~/Downloads → webdav.${credentials.domain}`);
    console.log(
      `  Chrome CDP: port ${cdpPort}   → chrome.${credentials.domain}`,
    );
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
          console.log(chalk.dim("\nPress ^C again to disconnect and exit..."));
        } else {
          done();
        }
      };
      process.on("SIGINT", onSigint);
      process.once("SIGTERM", done);
    });
  } finally {
    console.log();
    console.log(chalk.cyan("Stopping services..."));
    wsgidav.kill("SIGTERM");
    chrome.kill("SIGTERM");
    await stopNgrokTunnels();
    console.log(chalk.green("✓ Services stopped"));
  }
}
