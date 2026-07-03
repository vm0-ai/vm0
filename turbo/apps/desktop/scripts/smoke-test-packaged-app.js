const { spawn } = require("node:child_process");
const fs = require("node:fs");

const { packagedAppPaths } = require("./packaged-app-paths");

const READY_MARKER = "[smoke-test] desktop main ready";
const LAUNCH_TIMEOUT_MS = 60_000;

if (process.platform !== "darwin") {
  throw new Error("Packaged desktop smoke tests are only supported on macOS.");
}

const { executablePath, mainBundlePath } = packagedAppPaths(
  process.env.VM0_DESKTOP_PLATFORM_URL,
);

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable was not found at ${executablePath}`);
}

const mainBundle = fs.readFileSync(mainBundlePath, "utf8");
for (const unbundledRequire of ['require("@vm0/', "require('@vm0/"]) {
  if (mainBundle.includes(unbundledRequire)) {
    throw new Error(
      `Packaged main bundle contains an unbundled workspace require (${unbundledRequire}...). ` +
        "Workspace packages must be bundled via tsup noExternal; see tsup.electron.config.js.",
    );
  }
}
console.log(
  `Main bundle has no unbundled workspace requires: ${mainBundlePath}`,
);

const child = spawn(executablePath, [], {
  env: { ...process.env, VM0_DESKTOP_SMOKE_TEST: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
}, LAUNCH_TIMEOUT_MS);

child.on("close", (code, signal) => {
  clearTimeout(timeout);

  const succeeded = code === 0 && stdout.includes(READY_MARKER);
  if (succeeded) {
    console.log(`Packaged app launched and reported ready: ${executablePath}`);
    return;
  }

  console.error(
    signal === "SIGKILL"
      ? `Packaged app did not report ready within ${LAUNCH_TIMEOUT_MS}ms`
      : `Packaged app exited with code ${code} (signal ${signal}) before reporting ready`,
  );
  console.error(`--- stdout ---\n${stdout}`);
  console.error(`--- stderr ---\n${stderr}`);
  process.exitCode = 1;
});
